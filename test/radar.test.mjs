// Unit tests for the pure parts of the radar: analyse() and render(). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyse, render, envName, updaterOf, detectUpdaters, kindOf, checksState, noiseOf, dashboard, priorityOf, plural, gapLines, PROJECTS_QUERY, ENGINE_VERSION } from "../scripts/radar.mjs";

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
  assert.match(md, /1 repo on Renovate, 0 on Dependabot, 1 on both, 1 on neither/);
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

test("headline counts read naturally for one and many", () => {
  assert.equal(plural(1, "repo"), "1 repo");
  assert.equal(plural(2, "repo"), "2 repos");
  const md = render([repo()], analyse([repo()], null), []);
  assert.match(md, /^1 active repo \(/m);
  assert.match(md, /0 open PRs, 0 open issues/);
});

test("the goals section is never blank: it says no goals are set, or lists each goal", () => {
  const md = render([repo()], analyse([repo()], null), []);
  const goals = Object.keys(JSON.parse(readFileSync(new URL("../radar.config.json", import.meta.url), "utf8")).goalRepos ?? {});
  const section = md.split("## 5. Toward your goals\n\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(section, /^- /, "section 5 has at least one line");
  if (!goals.length) assert.match(section, /^- No goals set\./);
  else for (const g of goals) assert.ok(section.includes(g), `goal "${g}" is listed`);
});

test("Couldn't check names the repos and says why, instead of 'some repos'", () => {
  const lines = gapLines({ unreadable: new Set(), dependabot: new Set(["o/b", "o/a"]), codeScanning: new Set(["o/a"]), secretScanning: new Set() });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Dependabot alerts not readable for 2 repos: o\/a, o\/b\. Usually/);
  assert.match(lines[1], /^Code scanning not readable for 1 repo: o\/a\..*Advanced Security/);
  const many = gapLines({ secretScanning: new Set(Array.from({ length: 10 }, (_, i) => `o/r${i}`)) }, 3);
  assert.match(many[0], /o\/r0, o\/r1, o\/r2 and 7 more\./);
  assert.ok(!lines.join(" ").includes("Some repos"));
});

test("Projects are read through repositoryOwner, so an org as owner works", () => {
  assert.match(PROJECTS_QUERY, /repositoryOwner\(login:\$login\)\{ \.\.\. on ProjectV2Owner/);
  assert.doesNotMatch(PROJECTS_QUERY, /\buser\(login|organization\(login/);
});

test("report and dashboard carry the engine version from engine.json, and the credit line", () => {
  const v = JSON.parse(readFileSync(new URL("../engine.json", import.meta.url), "utf8")).version;
  assert.equal(ENGINE_VERSION, v);
  const md = render([repo()], analyse([repo()], null), []);
  assert.ok(md.includes(`portfolio-radar engine v${v}.`));
  assert.match(md, /Built with ❤️ by Chris Phillipson, Principal, CP Ventures Group, LLC/);
  assert.equal(dashboard([repo()], analyse([repo()], null), { generated: "2026-11-05T00:00:00Z" }).engine, v);
});

// ---------- Metrics ----------
import { countFromLink, activeForks, linksBack, windowsFromSeries, windowsFromSnapshots, combineWindows, attributeSkips, countedFile, countLines, languageOf, manifestPackages, isWeeklyRun, dlCell, metricsSection, metricGapLines } from "../scripts/radar.mjs";

test("closed PR count comes from the Link header's last page", () => {
  assert.equal(countFromLink('<https://api.github.com/repositories/1/pulls?state=closed&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/pulls?state=closed&per_page=1&page=388>; rel="last"', 1), 388);
  assert.equal(countFromLink(null, 1), 1);
  assert.equal(countFromLink(null, 0), 0);
});

test("a fork is active only if pushed after forking and within the window", () => {
  const at = new Date("2026-11-16T00:00:00Z");
  const forks = [
    { created_at: "2026-01-01T00:00:00Z", pushed_at: "2025-12-31T00:00:00Z" }, // never pushed to: inherits parent's push
    { created_at: "2026-01-01T00:00:00Z", pushed_at: "2026-10-01T00:00:00Z" }, // own work, recent
    { created_at: "2025-01-01T00:00:00Z", pushed_at: "2025-03-01T00:00:00Z" }, // own work, too long ago
    { created_at: "2026-09-01T00:00:00Z", pushed_at: "2026-09-01T00:00:30Z" }, // pushed at the moment of forking
  ];
  assert.equal(activeForks(forks, at, 6), 1);
  assert.equal(activeForks(forks, at, 24), 2);
});

test("a package counts only if its registry entry points back to the repo", () => {
  assert.ok(linksBack("git+https://github.com/octo-user/demo.git", "octo-user/demo"));
  assert.ok(linksBack("https://github.com/Octo-User/Demo/tree/main/pkg", "octo-user/demo"));
  assert.ok(linksBack("git@github.com:octo-user/demo.git", "octo-user/demo"));
  assert.ok(!linksBack("https://github.com/octo-user/demo-two", "octo-user/demo"));
  assert.ok(!linksBack("https://github.com/someone-else/demo", "octo-user/demo"));
  assert.ok(!linksBack(undefined, "octo-user/demo"));
});

test("registry series give full windows, or say when they start", () => {
  const series = Array.from({ length: 200 }, (_, i) => ({ date: new Date(Date.UTC(2026, 4, 1) + i * 86400e3).toISOString().slice(0, 10), n: 1 }));
  const w = windowsFromSeries(series);
  assert.deepEqual([w.d1.n, w.d7.n, w.d30.n, w.d182.n], [1, 7, 30, 182]);
  assert.equal(w.d182.since, null);
  const short = windowsFromSeries(series.slice(-90));
  assert.equal(short.d30.since, null);
  assert.equal(short.d182.n, 90);
  assert.equal(short.d182.since, series.at(-90).date);
  assert.equal(windowsFromSeries([]), null);
});

test("lifetime totals become windows from snapshots, partial until old enough", () => {
  const hist = [{ date: "2026-11-10", value: 100 }, { date: "2026-11-15", value: 140 }];
  const w = windowsFromSnapshots(150, hist, "2026-11-16");
  assert.deepEqual(w.d1, { n: 10, since: null });
  assert.deepEqual(w.d7, { n: 50, since: "2026-11-10" }); // no snapshot from Nov 9, so it starts Nov 10
  assert.deepEqual(w.d182, { n: 50, since: "2026-11-10" });
});

test("a total that went down is unknown, not a negative or zero", () => {
  const w = windowsFromSnapshots(80, [{ date: "2026-11-15", value: 100 }], "2026-11-16");
  assert.equal(w.d1.n, null);
  assert.match(w.d1.reason, /deleted/);
});

test("no earlier snapshot means unknown, never zero", () => {
  const w = windowsFromSnapshots(80, [], "2026-11-16");
  assert.equal(w.d7.n, null);
  assert.equal(windowsFromSnapshots(null, [], "2026-11-16"), null);
});

test("combined windows: any unknown part is unknown, and since is the shortest span", () => {
  const a = { d1: { n: 1, since: null }, d7: { n: 7, since: null }, d30: { n: 30, since: null }, d182: { n: 182, since: null } };
  const b = { d1: { n: 2, since: null }, d7: { n: 5, since: "2026-11-12" }, d30: { n: 5, since: "2026-11-10" }, d182: { n: null } };
  const c = combineWindows([a, b]);
  assert.deepEqual(c.d1, { n: 3, since: null });
  assert.deepEqual(c.d7, { n: 12, since: "2026-11-12" });
  assert.equal(c.d182, null);
});

test("lines of code skip vendored, generated, lock, minified and non-code files", () => {
  const skips = attributeSkips("# comment\nthird/** linguist-vendored\n*.gen.ts linguist-generated=true\ndocs/** linguist-documentation\n/api/schema.ts linguist-generated\n");
  assert.ok(countedFile("src/index.ts", skips));
  assert.ok(countedFile("crates/core/src/lib.rs", skips));
  assert.ok(!countedFile("node_modules/x/index.js", skips));
  assert.ok(!countedFile("web/dist/app.js", skips));
  assert.ok(!countedFile("public/app.min.js", skips));
  assert.ok(!countedFile("package-lock.json", skips));
  assert.ok(!countedFile("README.md", skips));
  assert.ok(!countedFile("third/lib/a.c", skips));
  assert.ok(!countedFile("src/models.gen.ts", skips));
  assert.ok(!countedFile("api/schema.ts", skips));
  assert.ok(countedFile("pkg/api/schema.ts", skips)); // anchored pattern only matches at the root
  assert.equal(languageOf("a/b.tsx"), "TypeScript");
  assert.equal(countLines("a\n\n  \nb\n  c\n"), 3);
  assert.equal(countLines("bin\u0000ary\nmore"), 0);
});

test("packages come from root manifests, skipping private and unpublished ones", () => {
  assert.deepEqual(manifestPackages({ packageJson: '{"name":"@octo/demo"}', cargoToml: '[package]\nname = "demo-cli"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n', pyproject: '[project]\nname = "demo-py"\n' }), ["npm:@octo/demo", "crates:demo-cli", "pypi:demo-py"]);
  assert.deepEqual(manifestPackages({ packageJson: '{"name":"demo","private":true}', cargoToml: '[package]\nname = "x"\npublish = false\n' }), []);
  assert.deepEqual(manifestPackages({ cargoToml: '[workspace]\nmembers = ["a"]\n' }), []);
  assert.deepEqual(manifestPackages({ packageJson: "not json" }), []);
});

test("weekly fields refresh on the set weekday, on request, or when nothing is carried yet", () => {
  assert.equal(isWeeklyRun("2026-11-16T11:23:00Z", "2026-11-09", 1, false), true); // a Monday
  assert.equal(isWeeklyRun("2026-11-17T11:23:00Z", "2026-11-16", 1, false), false);
  assert.equal(isWeeklyRun("2026-11-17T11:23:00Z", null, 1, false), true);
  assert.equal(isWeeklyRun("2026-11-17T11:23:00Z", "2026-11-16", 1, true), true);
});

test("metrics table shows unknown as ?, nothing to download as -, and partial windows with a date", () => {
  const m = (over) => ({ created: "2025-02-10T00:00:00Z", lastCommit: "2026-11-16T00:00:00Z", stars: 5, openIssues: 2, prsClosed: 10, prsMerged: 8,
    forks: { total: 4, active: 1 }, loc: { total: 12000 }, downloads: { sources: ["releases"], d1: 3, d7: 20, d30: null, d182: 40, partialSince: { d182: "2026-11-10" } }, weeklyAt: "2026-11-16", ...over });
  assert.equal(dlCell(m(), "d1"), "3");
  assert.equal(dlCell(m(), "d30"), "?");
  assert.equal(dlCell(m(), "d182"), "40 since Nov 10");
  assert.equal(dlCell(m({ downloads: { sources: [], d1: null } }), "d1"), "-");
  assert.equal(dlCell(null, "d1"), "?");
  const lines = metricsSection([repo({ name: "a", metrics: m({ stars: 1, loc: null }) }), repo({ name: "b", metrics: m() }), repo({ name: "c", metrics: null })]);
  const rows = lines.filter((l) => /^\| [abc] /.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| b \| 2025-02-10 \| 2026-11-16 \| 5 \| 1\/4 \| 2 \| 10 \(8\) \| 12,000 \|/);
  assert.match(rows[1], /\| \? \| 3 \|/); // a: lines of code unknown
  assert.deepEqual(metricsSection([repo({ metrics: null })]), []);
  const noLoc = metricsSection([repo({ name: "a", metrics: m({ loc: null }) })], { loc: false });
  assert.ok(metricsSection([repo({ name: "a", metrics: m({ loc: null }) })], { loc: true }).some((l) => /Lines of code/.test(l)));
  assert.ok(!noLoc.some((l) => /Lines of code/.test(l)), "lines of code column is left out when it's off and never counted");
});

test("metric gaps are named, never hidden", () => {
  const lines = metricGapLines({ loc: new Set(["octo-user/b", "octo-user/a"]), forks: new Set() });
  assert.deepEqual(lines, ["Metrics: lines of code not read for 2 repos: octo-user/a, octo-user/b."]);
});

import { weekStarts, weeklyFlow, WEEKLY_FIELDS } from "../scripts/radar.mjs";

test("weekStarts gives Mondays, oldest first, ending with the week that holds today", () => {
  assert.deepEqual(weekStarts("2026-11-23", 3), ["2026-11-09", "2026-11-16", "2026-11-23"]);
  assert.deepEqual(weekStarts("2026-11-29", 2), ["2026-11-16", "2026-11-23"]); // a Sunday is still that week
  assert.equal(weekStarts("2026-11-23", 12).length, 12);
});

test("weeklyFlow backfills every week, then only refetches the newest two", async () => {
  const calls = [];
  const search = async (q, o) => { calls.push(q); return 2; };
  const first = await weeklyFlow({ owners: ["octo-user", "octo-org"], today: "2026-11-23", weeks: 4, search });
  assert.equal(first.weekly.length, 4);
  assert.equal(first.weekly.at(-1).partial, true);
  assert.equal(first.weekly[0].partial, false);
  // prsMerged: 2 owners x 2 per query; botPrsMerged: 2 queries x 2 owners x 2
  assert.equal(first.weekly[0].prsMerged, 4);
  assert.equal(first.weekly[0].botPrsMerged, 8);
  assert.equal(first.gaps.size, 0);
  assert.ok(calls.every((q) => /archived:false/.test(q)), "archived repos stay out of the flow");
  assert.ok(calls.some((q) => /author:app\/renovate/.test(q)) && calls.some((q) => /author:app\/dependabot/.test(q)));
  calls.length = 0;
  const next = await weeklyFlow({ owners: ["octo-user", "octo-org"], today: "2026-11-24", weeks: 4, prev: first.weekly, search });
  // two weeks refreshed (newest two), two carried forward: 2 weeks x 5 queries x 2 owners
  assert.equal(calls.length, 20);
  assert.equal(next.weekly[0].prsMerged, 4, "an old week is carried forward untouched");
});

test("weeklyFlow shows an unreadable count as null, never 0, and keeps the last good value", async () => {
  const flaky = async (q) => (/is:issue is:closed/.test(q) ? null : 3);
  const res = await weeklyFlow({ owners: ["octo-user"], today: "2026-11-23", weeks: 2, search: flaky });
  assert.equal(res.weekly[0].issuesClosed, null);
  assert.equal(res.weekly[0].prsMerged, 3);
  assert.deepEqual([...res.gaps], ["issuesClosed"]);
  const again = await weeklyFlow({ owners: ["octo-user"], today: "2026-11-23", weeks: 2, prev: [{ week: "2026-11-16", prsMerged: 9, botPrsMerged: 1, issuesClosed: 5, issuesOpened: 1 }], search: flaky });
  assert.equal(again.weekly[0].issuesClosed, 5, "the earlier good value survives a failed re-read");
  assert.ok(WEEKLY_FIELDS.includes("issuesOpened"));
});

test("weeklyFlow counts only readable owners, names the rest, and refetches when the owners change", async () => {
  const calls = [];
  const search = async (q, o) => { calls.push(o); return o === "acme-client" ? null : 2; };
  const canRead = (o) => o !== "acme-client";
  const res = await weeklyFlow({ owners: ["octo-user", "acme-client"], today: "2026-11-23", weeks: 3, search, canRead });
  assert.ok(!calls.includes("acme-client"), "an owner without a token is never searched");
  assert.deepEqual(res.skipped, ["acme-client"]);
  assert.equal(res.gaps.size, 0, "one unreadable owner no longer blanks every count");
  assert.equal(res.weekly[0].prsMerged, 2);
  assert.deepEqual(res.weekly[0].owners, ["octo-user"]);
  const later = await weeklyFlow({ owners: ["octo-user", "acme-client"], today: "2026-11-23", weeks: 3, prev: res.weekly, search: async () => 5, canRead });
  assert.equal(later.weekly[0].prsMerged, 2, "an old week stays put while the owners are the same");
  const grown = await weeklyFlow({ owners: ["octo-user", "acme-client"], today: "2026-11-23", weeks: 3, prev: res.weekly, search: async () => 5 });
  assert.equal(grown.weekly[0].prsMerged, 10, "once the owner is readable, the old week is counted again for both");
  assert.deepEqual(grown.skipped, []);
  const none = await weeklyFlow({ owners: ["acme-client"], today: "2026-11-23", weeks: 3, search, canRead });
  assert.equal(none.weekly, null, "no readable owner means no weekly series, not a row of gaps");
});

test("dashboard carries the weekly series and the new health totals", () => {
  const repos = [
    repo({ name: "a", updates: { tools: ["renovate"], configured: true }, prs: [{ number: 1, title: "t", url: "u", draft: false, bot: false, author: "x", created: iso(10), updated: iso(1) }] }),
    repo({ name: "b", updates: { tools: ["renovate", "dependabot"], configured: true } }),
  ];
  const weekly = [{ week: "2026-11-16", prsMerged: 3, botPrsMerged: 1, issuesClosed: 2, issuesOpened: 4, partial: false }];
  const d = dashboard(repos, analyse(repos, null), { weekly });
  assert.deepEqual(d.weekly, weekly);
  assert.equal(d.totals.renovateOnly, 1);
  assert.ok([9, 10].includes(d.totals.prAgeMedian), "median age of the one open people PR, in days");
  assert.equal(dashboard([repo()], analyse([repo()], null), {}).totals.prAgeMedian, null, "no open PRs means unknown, not 0");
});
