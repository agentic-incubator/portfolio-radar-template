// Unit tests for the pure parts of the radar: analyse() and render(). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, render, envName, updaterOf, detectUpdaters, kindOf, checksState, noiseOf, dashboard, priorityOf } from "../scripts/radar.mjs";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const repo = (over = {}) => ({
  name: "demo", owner: "octo-user", client: false, url: "https://github.com/octo-user/demo", private: true,
  defaultBranch: "main", pushedAt: iso(1), readable: true, hasAgents: true, latestRelease: null,
  prs: [], issues: [], failingWorkflows: [], dependabot: [], codeScanning: [], secretScanning: [],
  ...over,
});

test("envName maps owners to secret-style env names", () => {
  assert.equal(envName("octo-org"), "RADAR_TOKEN_OCTO_ORG");
  assert.equal(envName("acme-client"), "RADAR_TOKEN_ACME_CLIENT");
});

test("exposed secrets rank above everything else", () => {
  const a = analyse([
    repo({ name: "a", failingWorkflows: [{ name: "CI", url: "u" }] }),
    repo({ name: "b", secretScanning: [{ id: 1, type: "AWS key", url: "u" }] }),
  ], null);
  assert.match(a.needs[0].text, /exposed secret/);
  assert.match(a.needs[1].text, /`CI` failing/);
});

test("only critical/high alerts reach 'needs you', and new ones are counted", () => {
  const prev = { repos: [repo({ name: "a", dependabot: [{ id: 1, severity: "high", pkg: "x" }] })] };
  const a = analyse([repo({ name: "a", dependabot: [
    { id: 1, severity: "high", pkg: "x" }, { id: 2, severity: "critical", pkg: "y" }, { id: 3, severity: "low", pkg: "z" },
  ] })], prev);
  assert.equal(a.needs.length, 1);
  assert.match(a.needs[0].text, /2 critical\/high security alert\(s\), 1 new/);
});

test("drift and cross-repo patterns", () => {
  const dep = { id: 1, severity: "medium", pkg: "lodash", ecosystem: "npm" };
  const bots = [1, 2, 3].map((n) => ({ number: n, title: "bump", bot: true, created: iso(2), updated: iso(2) }));
  const a = analyse([
    repo({ name: "old", pushedAt: iso(400), hasAgents: false, dependabot: [dep] }),
    repo({ name: "busy", prs: bots, dependabot: [dep] }),
    repo({ name: "unread", readable: false, hasAgents: null }),
  ], null);
  assert.ok(a.drift.stale.some((s) => s.startsWith("old")));
  assert.deepEqual(a.drift.noAgents, ["old"]); // unreadable repos are not reported as missing AGENTS.md
  assert.deepEqual(a.drift.botPrPiles, ["busy (other bots 3)"]);
  assert.match(a.patterns[0], /`lodash` \(npm\) has open alerts in 2 repos/);
});

test("render produces every section", () => {
  const repos = [repo()];
  const md = render(repos, analyse(repos, null), []);
  for (const h of ["# Portfolio radar", "## 1. Needs you today", "## 2. Changed", "## 3. Drift", "## 4. Patterns", "## 5. Toward your goals"]) {
    assert.ok(md.includes(h), h);
  }
});

test("appJwt is a valid RS256 JWT for the app", async () => {
  const { generateKeyPairSync, createVerify } = await import("node:crypto");
  const { appJwt } = await import("../scripts/radar.mjs");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt(12345, privateKey.export({ type: "pkcs1", format: "pem" }), 1_000_000);
  const [h, p, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 999_940, exp: 1_000_540, iss: "12345" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url"));
});

test("paged follows Link rel=next (cursor paging, as the alert APIs require)", async () => {
  const { paged } = await import("../scripts/radar.mjs");
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(url);
    const second = url.includes("after=abc");
    return new Response(JSON.stringify(second ? [{ n: 3 }] : [{ n: 1 }, { n: 2 }]), {
      status: 200,
      headers: second ? {} : { link: '<https://api.github.com/repos/o/r/dependabot/alerts?per_page=100&after=abc>; rel="next"' },
    });
  };
  try {
    const all = await paged("/repos/o/r/dependabot/alerts?state=open");
    assert.deepEqual(all.map((x) => x.n), [1, 2, 3]);
    assert.ok(!/[?&]page=/.test(seen[0]), "no ?page= parameter");
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

test("updaterOf recognises Renovate and Dependabot authors", () => {
  assert.equal(updaterOf("dependabot[bot]"), "dependabot");
  assert.equal(updaterOf("renovate[bot]"), "renovate");
  assert.equal(updaterOf("renovate-bot"), "renovate"); // self-hosted Renovate
  assert.equal(updaterOf("github-actions[bot]"), null);
  assert.equal(updaterOf("octo-user"), null);
});

test("detectUpdaters: config files, PRs and the Renovate dashboard", () => {
  assert.deepEqual(detectUpdaters({ rootFiles: ["renovate.json"] }).tools, ["renovate"]);
  assert.deepEqual(detectUpdaters({ githubFiles: ["renovate.json5"] }).tools, ["renovate"]);
  assert.deepEqual(detectUpdaters({ githubFiles: ["dependabot.yml"] }).tools, ["dependabot"]);
  assert.deepEqual(detectUpdaters({ rootFiles: [".renovaterc"], githubFiles: ["dependabot.yaml"] }).tools, ["dependabot", "renovate"]);
  // Renovate configured in package.json: only its PRs or dashboard give it away
  const d = detectUpdaters({ prs: [{ updater: "renovate" }, { updater: "renovate" }], issues: [{ author: "renovate[bot]", title: "Dependency Dashboard", url: "u" }] });
  assert.deepEqual(d.tools, ["renovate"]);
  assert.deepEqual(d.configured, []);
  assert.equal(d.prs.renovate, 2);
  assert.equal(d.dashboard, "u");
  assert.deepEqual(detectUpdaters({}).tools, []);
});

test("updater drift: split bot piles, flag both and none", () => {
  const mk = (u) => ({ number: 1, title: "bump", bot: true, updater: u, created: iso(1), updated: iso(1) });
  const a = analyse([
    repo({ name: "r1", prs: [mk("renovate"), mk("renovate"), mk("dependabot")], updates: { tools: ["dependabot", "renovate"], dashboard: "d" } }),
    repo({ name: "r2", updates: { tools: ["renovate"] } }),
    repo({ name: "r3", updates: { tools: [] } }),
    repo({ name: "r4", readable: false, updates: null }),
  ], null);
  assert.deepEqual(a.drift.botPrPiles, ["r1 (renovate 2, dependabot 1, [dashboard](d))"]);
  assert.deepEqual(a.drift.updaters, { renovate: ["r2"], dependabot: [], both: ["r1"], none: ["r3"] });
  const md = render([], a, []);
  assert.match(md, /1 repos on Renovate, 0 on Dependabot, 1 on both, 1 on neither/);
});

test("paged keeps the owner's token when next links use /repositories/<id>", async () => {
  const { paged } = await import("../scripts/radar.mjs");
  process.env.RADAR_TOKEN_SOMEORG = "org-token";
  const auths = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    auths.push(opts.headers.Authorization);
    const first = !url.includes("/repositories/");
    return new Response(JSON.stringify([{}]), {
      status: 200,
      headers: first ? { link: '<https://api.github.com/repositories/123/issues?per_page=100&page=2>; rel="next"' } : {},
    });
  };
  try {
    await paged("/repos/someorg/r/issues?state=open");
    assert.deepEqual(auths, ["Bearer org-token", "Bearer org-token"]);
  } finally {
    globalThis.fetch = real;
    delete process.env.RADAR_TOKEN_SOMEORG;
  }
});

// ---------- Noise, PR checks and the dashboard view model ----------

test("kindOf: archived beats fork, and activeForks makes a fork active", () => {
  const c = { activeForks: ["mine"] };
  assert.equal(kindOf({ name: "a", archived: true, fork: true }, c), "archived");
  assert.equal(kindOf({ name: "b", fork: true }, c), "fork");
  assert.equal(kindOf({ name: "mine", fork: true }, c), "active");
  assert.equal(kindOf({ name: "c" }, c), "active");
});

test("checksState takes the latest run per workflow", () => {
  const run = (id, status, conclusion, at) => ({ workflow_id: id, status, conclusion, created_at: iso(at) });
  assert.equal(checksState([]), "none");
  assert.equal(checksState([run(1, "completed", "failure", 2), run(1, "completed", "success", 1)]), "green");
  assert.equal(checksState([run(1, "completed", "success", 1), run(2, "completed", "failure", 1)]), "red");
  assert.equal(checksState([run(1, "completed", "success", 1), run(2, "in_progress", null, 1)]), "pending");
  assert.equal(checksState([run(1, "completed", "skipped", 1)]), "green");
});

test("noiseOf: quiet repos are left out and each kind gets a fitting first option", () => {
  const alert = { id: 1, severity: "high", pkg: "x", ecosystem: "npm" };
  const n = noiseOf([
    repo({ name: "quiet-fork", kind: "fork", fork: { parent: "up/q", ahead: 0, behind: 3 } }),
    repo({ name: "old", kind: "archived", dependabot: [alert] }),
    repo({ name: "copy", kind: "fork", fork: { parent: "up/c", ahead: 0, behind: 40 }, prs: [{ number: 1, bot: true, updater: "dependabot" }] }),
    repo({ name: "mine", kind: "fork", fork: { parent: "up/m", ahead: 5, behind: 1 }, dependabot: [alert] }),
    repo({ name: "unknown", kind: "fork", fork: { parent: null, ahead: null, behind: null }, dependabot: [alert] }),
  ]);
  const by = Object.fromEntries(n.map((x) => [x.name, x]));
  assert.ok(!by["quiet-fork"]);
  assert.equal(by.old.recommended, "silence-alerts");
  assert.equal(by.copy.recommended, "delete");
  assert.equal(by.mine.recommended, "promote");
  assert.equal(by.unknown.recommended, "silence-fork"); // never suggest deleting a fork whose own work is unknown
  assert.equal(by.old.signals.critHigh, 1);
});

test("noiseOf: an archived repo's old red run isn't noise, and without alerts the first option tidies its PRs", () => {
  const n = noiseOf([
    repo({ name: "ran-once", kind: "archived", failingWorkflows: [{ name: "CI", url: "u" }] }),
    repo({ name: "prs-only", kind: "archived", prs: [{ number: 1, bot: true, updater: "dependabot" }] }),
  ]);
  assert.deepEqual(n.map((x) => x.name), ["prs-only"]);
  assert.equal(n[0].recommended, "fix-and-rearchive");
  assert.ok(!n[0].options.some((o) => o.id === "silence-alerts"));
});

test("an exposed secret in an archived repo still reaches 'needs you'", () => {
  const noisy = [repo({ name: "attic", kind: "archived", secretScanning: [{ id: 1, type: "AWS key", url: "u" }] })];
  const a = analyse([repo()], null, noisy);
  assert.match(a.needs[0].text, /attic\*\* \(archived\): exposed secret/);
  assert.equal(a.noise[0].name, "attic");
  assert.match(render([repo()], a, []), /## 6\. Noise: archived and forked repos[\s\S]*attic/);
});

test("render says so when there's no noise", () => {
  const repos = [repo()];
  assert.match(render(repos, analyse(repos, null, []), []), /## 6\. Noise[\s\S]*- None/);
});

test("priorityOf orders secrets, critical alerts, CI, human PRs, drift", () => {
  const order = [
    repo({ secretScanning: [{ id: 1, type: "t", url: "u" }] }),
    repo({ dependabot: [{ id: 1, severity: "critical", pkg: "x" }] }),
    repo({ failingWorkflows: [{ name: "CI", url: "u" }] }),
    repo({ prs: [{ number: 1, bot: false, draft: false }] }),
    repo({ prs: [1, 2, 3].map((n) => ({ number: n, bot: true })) }),
    repo({ pushedAt: iso(400) }),
    repo(),
  ].map(priorityOf);
  assert.deepEqual(order.map((p) => p.level), ["secret", "critical", "ci", "prs", "drift", "stale", "ok"]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1].score > order[i].score, `score ${i}`);
});

test("dashboard carries history forward, one row per day, and marks fresh repos", () => {
  const repos = [repo({ name: "a", failingWorkflows: [{ name: "CI", url: "u" }] })];
  const a = analyse(repos, null, []);
  const prev = { history: [{ date: "2026-11-04", repos: 1 }, { date: new Date().toISOString().slice(0, 10), repos: 99 }], repos: [{ fullName: "octo-user/a", score: 3 }] };
  const d = dashboard(repos, a, { prev });
  assert.equal(d.schema, 1);
  assert.deepEqual(d.history.map((h) => h.repos), [1, 1]); // today's stale row replaced
  assert.equal(d.repos[0].level, "ci");
  assert.equal(d.repos[0].fresh, true);
  assert.equal(d.totals.failing, 1);
  const seeded = dashboard(repos, a, { seed: { generated: "2026-11-01T00:00:00Z", repos: [repo(), repo()] } });
  assert.deepEqual(seeded.history.map((h) => [h.date, h.repos]), [["2026-11-01", 2], [new Date().toISOString().slice(0, 10), 1]]);
});
