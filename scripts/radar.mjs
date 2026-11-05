#!/usr/bin/env node
// Daily portfolio radar: one ranked report across every active repo, with archived and forked repos kept apart as noise.
// Zero dependencies. Node 24+. Reads radar.config.json. Writes reports/ and data/.
// Auth (see docs/how-it-works.md):
//   Actions: RADAR_APP_ID + RADAR_APP_PRIVATE_KEY. The script signs in as the GitHub App, finds every
//            installation, and mints one read-only installation token per owner. No per-owner setup here.
//   Local:   RADAR_TOKEN (any read-only token), or RADAR_USE_GH=1 to use your gh CLI login.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "radar.config.json"), "utf8"));
if (!cfg.owner && process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('radar.config.json has no "owner". Set it to your GitHub login (or run /radar-setup).');
  process.exit(1);
}
const TOKEN = process.env.RADAR_TOKEN;
// Tokens are per owner: RADAR_TOKEN_<OWNER> (e.g. RADAR_TOKEN_CF_TOOLSUITE) wins over RADAR_TOKEN for that owner.
export const envName = (owner) => `RADAR_TOKEN_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const tokenFor = (owner) => (owner && process.env[envName(owner)]) || TOKEN;
const ownerOf = (path) => /^\/(?:repos|orgs|users)\/([^/]+)/.exec(path)?.[1];
const USE_GH = process.env.RADAR_USE_GH === "1";
// App mode: each token is a GitHub App installation token, so repos are listed via /installation/repositories.
let APP = process.env.RADAR_AUTH === "app";
const LIMIT = Number(process.env.RADAR_LIMIT || 0); // testing: only the first N repos

const now = new Date();
const today = now.toISOString().slice(0, 10);
const since = new Date(now.getTime() - cfg.lookbackHours * 3600e3);
const warnings = new Set();
const OWNERS = [...(cfg.owners ?? [cfg.owner]), ...(cfg.clientOwners ?? [])];

// ---------- API ----------
// Returns the parsed body. With { withNext: true } returns { data, next }, where next is the Link header's
// rel="next" path. GitHub's alert endpoints only support Link (cursor) paging, not ?page=N.
async function api(path, { optional = false, owner, withNext = false } = {}) {
  try {
    if (USE_GH) {
      const out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      const data = JSON.parse(out);
      return withNext ? { data, next: null } : data; // gh mode: first page only (local testing)
    }
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${tokenFor(owner ?? ownerOf(path))}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "portfolio-radar",
      },
    });
    if (res.status === 204) return withNext ? { data: null, next: null } : null;
    if (!res.ok) {
      const err = new Error(`${res.status} ${path}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (!withNext) return data;
    const next = /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { data, next };
  } catch (e) {
    const status = USE_GH ? Number(/HTTP (\d{3})/.exec(String(e.stderr || e.message))?.[1] ?? 0) : e.status;
    if (optional && [403, 404, 409, 410, 422].includes(Number(status))) return undefined;
    throw e;
  }
}

// Follows Link rel="next", which works for every list endpoint (page- or cursor-based).
export const itemsOf = (batch) => (Array.isArray(batch) ? batch : batch?.items ?? batch?.repositories ?? []);
export async function paged(path, max = 500, owner) {
  // Next links can point at /repositories/<id>/…, which names no owner, so pin the owner from the first path.
  owner ??= ownerOf(path);
  const all = [];
  let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (next && all.length < max) {
    const res = await api(next, { optional: true, owner, withNext: true });
    if (res === undefined) return undefined;
    all.push(...itemsOf(res.data));
    next = res.next;
  }
  return all;
}

async function graphql(query, variables = {}, owner) {
  if (USE_GH || !tokenFor(owner)) return undefined; // GraphQL needs a token (not gh mode)
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor(owner)}`, "Content-Type": "application/json", "User-Agent": "portfolio-radar" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) {
    warnings.add(`GitHub Projects not read for ${owner}: ${body.errors[0].message}`);
    return undefined;
  }
  return body.data;
}

// ---------- GitHub App auth ----------
const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
export function appJwt(appId, privateKey, at = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: at - 60, exp: at + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${sig}`;
}

// Sign in as the app, list its installations, and mint one installation token per configured owner.
// Installations on owners not in radar.config.json are reported, so a new install is never silently ignored.
async function mintAppTokens(appId, privateKey) {
  const jwt = appJwt(appId, privateKey);
  const gh = async (path, method = "GET") => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "portfolio-radar" },
    });
    if (!res.ok) throw new Error(`GitHub App sign-in failed: ${res.status} ${path}. Check RADAR_APP_ID and RADAR_APP_PRIVATE_KEY.`);
    return res.json();
  };
  const installs = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/app/installations?per_page=100&page=${page}`);
    installs.push(...batch);
    if (batch.length < 100) break;
  }
  const wanted = new Set(OWNERS.map((o) => o.toLowerCase()));
  for (const inst of installs) {
    const login = inst.account?.login;
    if (!login) continue;
    if (!wanted.has(login.toLowerCase())) {
      warnings.add(`The app is installed on ${login}, which isn't in radar.config.json, so it was skipped. Add it to owners or clientOwners to include it.`);
      continue;
    }
    if (inst.suspended_at) { warnings.add(`The app's install on ${login} is suspended.`); continue; }
    const { token } = await gh(`/app/installations/${inst.id}/access_tokens`, "POST");
    const configured = OWNERS.find((o) => o.toLowerCase() === login.toLowerCase());
    process.env[envName(configured)] = token;
  }
  APP = true;
}

// ---------- Collect ----------
async function listRepos() {
  let repos;
  if (USE_GH) {
    repos = [];
    for (const o of OWNERS) repos.push(...((await paged(`/search/repositories?q=${encodeURIComponent(`user:${o} fork:true`)}`)) ?? []));
  } else {
    repos = [];
    for (const o of OWNERS) {
      if (!tokenFor(o)) {
        warnings.add(`Not checked: ${o}. ${APP ? "The GitHub App isn't installed there yet (see docs/setup.md)." : `No token for it (${envName(o)}).`}`);
        continue;
      }
      const path = APP
        ? `/installation/repositories`
        : o.toLowerCase() === cfg.owner.toLowerCase() ? `/user/repos?affiliation=owner&visibility=all` : `/orgs/${o}/repos?type=all`;
      let got;
      try { got = await paged(path, 2000, o); } catch (e) { got = undefined; }
      if (got === undefined) warnings.add(`Couldn't list repos for ${o}: GitHub refused the token.`);
      repos.push(...(got ?? []));
    }
  }
  return repos
    .filter((r) => OWNERS.map((o) => o.toLowerCase()).includes(r.owner?.login?.toLowerCase()))
    .filter((r) => cfg.includePrivate || !r.private)
    .filter((r) => !cfg.ignoreRepos.includes(r.name))
    .map((r) => ({ ...r, kind: kindOf(r, cfg) }))
    .filter((r) => r.kind === "active" || (r.kind === "archived" ? NOISE.archived : NOISE.forks))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Archived and forked repos are "noise": GitHub can still raise alerts and bot PRs on them, but they're not
// work in progress. A fork listed in activeForks is treated as an ordinary active repo.
const NOISE = { archived: true, forks: true, ...(cfg.noise ?? {}) };
export function kindOf(r, c = cfg) {
  if (r.archived) return "archived";
  if (r.fork && !(c.activeForks ?? []).some((n) => [r.name, r.full_name].includes(n))) return "fork";
  return "active";
}

// ---------- Dependency updaters (Renovate / Dependabot) ----------
// Renovate config can live at the root or in .github/ (also .gitlab/, or a "renovate" key in package.json,
// which we catch through Renovate's PRs instead). Dependabot version updates need .github/dependabot.yml.
const RENOVATE_ROOT = ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".renovaterc.json5"];
const RENOVATE_GH = ["renovate.json", "renovate.json5"];
const DEPENDABOT_GH = ["dependabot.yml", "dependabot.yaml"];
export const updaterOf = (login = "") =>
  /^dependabot(\[bot\])?$/i.test(login) ? "dependabot" : /renovate/i.test(login) ? "renovate" : null;
export function detectUpdaters({ rootFiles = [], githubFiles = [], prs = [], issues = [] }) {
  const has = (list, names) => list.some((f) => names.includes(f));
  const configured = new Set();
  if (has(rootFiles, RENOVATE_ROOT) || has(githubFiles, RENOVATE_GH)) configured.add("renovate");
  if (has(githubFiles, DEPENDABOT_GH)) configured.add("dependabot");
  const seen = new Set(prs.map((p) => p.updater).filter(Boolean));
  const dashboard = issues.find((i) => updaterOf(i.author) === "renovate" && /dependency dashboard/i.test(i.title));
  if (dashboard) seen.add("renovate");
  return {
    tools: [...new Set([...configured, ...seen])].sort(),
    configured: [...configured].sort(),
    prs: { renovate: prs.filter((p) => p.updater === "renovate").length, dependabot: prs.filter((p) => p.updater === "dependabot").length },
    dashboard: dashboard ? dashboard.url : null,
  };
}

async function collect(r) {
  const full = r.full_name;
  const branch = r.default_branch;
  const [pulls, issues, runs, dependabot, codeScan, secretScan, release, agents, rootDir, ghDir, detail] = await Promise.all([
    paged(`/repos/${full}/pulls?state=open`),
    paged(`/repos/${full}/issues?state=open`),
    api(`/repos/${full}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10&exclude_pull_requests=true`, { optional: true }),
    paged(`/repos/${full}/dependabot/alerts?state=open`),
    paged(`/repos/${full}/code-scanning/alerts?state=open`),
    paged(`/repos/${full}/secret-scanning/alerts?state=open`),
    api(`/repos/${full}/releases/latest`, { optional: true }),
    api(`/repos/${full}/contents/AGENTS.md`, { optional: true }),
    api(`/repos/${full}/contents`, { optional: true }),
    api(`/repos/${full}/contents/.github`, { optional: true }),
    r.fork ? api(`/repos/${full}`, { optional: true }) : null, // the list endpoints don't name a fork's parent
  ]);
  const readable = pulls !== undefined;
  if (!readable) warnings.add("Some repos could not be read at all (token lacks access); their rows show nothing.");
  if (dependabot === undefined) warnings.add("Some repos' Dependabot alerts weren't readable (alerts off or token lacks Dependabot alerts: read).");
  if (codeScan === undefined) warnings.add("Some repos have code scanning off, or the token lacks Code scanning alerts: read.");
  if (secretScan === undefined) warnings.add("Some repos have secret scanning off, or the token lacks Secret scanning alerts: read.");

  // Latest completed run per workflow on the default branch
  const latestByWf = new Map();
  for (const run of runs?.workflow_runs ?? []) {
    if (run.status !== "completed") continue;
    if (!latestByWf.has(run.workflow_id)) latestByWf.set(run.workflow_id, run);
  }
  const failing = [...latestByWf.values()].filter((x) => ["failure", "timed_out", "startup_failure"].includes(x.conclusion));

  const prs = (pulls ?? []).map((p) => ({
    number: p.number, title: p.title, url: p.html_url, draft: p.draft,
    author: p.user?.login, bot: p.user?.type === "Bot" || /\[bot\]$/.test(p.user?.login ?? "") || !!updaterOf(p.user?.login),
    updater: updaterOf(p.user?.login),
    created: p.created_at, updated: p.updated_at, headSha: p.head?.sha ?? null,
  }));
  // CI state of the PRs that could be shipped: human, not draft. Read from Actions runs on the PR's head
  // commit, which the app's Actions: read already covers (no Checks permission needed).
  for (const p of prs.filter((p) => !p.bot && !p.draft && p.headSha).slice(0, cfg.maxPrsListed)) {
    const prRuns = await api(`/repos/${full}/actions/runs?head_sha=${p.headSha}&per_page=50`, { optional: true });
    p.checks = prRuns === undefined ? "unknown" : checksState(prRuns.workflow_runs ?? []);
  }
  let fork = null;
  if (r.fork) {
    const parent = detail?.parent;
    fork = { parent: parent?.full_name ?? null, parentUrl: parent?.html_url ?? null, ahead: null, behind: null };
    if (parent) {
      const cmp = await api(`/repos/${full}/compare/${parent.owner.login}:${encodeURIComponent(parent.default_branch)}...${r.owner.login}:${encodeURIComponent(branch)}`, { optional: true });
      if (cmp) { fork.ahead = cmp.ahead_by; fork.behind = cmp.behind_by; }
      else warnings.add("Some forks couldn't be compared with their parent, so whether they hold work of your own is unknown.");
    }
  }
  const realIssues = (issues ?? []).filter((i) => !i.pull_request).map((i) => ({
    number: i.number, title: i.title, url: i.html_url, created: i.created_at, labels: i.labels.map((l) => l.name), author: i.user?.login,
  }));
  const names = (dir) => (Array.isArray(dir) ? dir.map((f) => f.name) : []);
  const updates = readable ? detectUpdaters({ rootFiles: names(rootDir), githubFiles: names(ghDir), prs, issues: realIssues }) : null;
  const sev = (a) => (a.security_advisory?.severity || a.rule?.security_severity_level || a.rule?.severity || "unknown").toLowerCase();

  return {
    name: r.owner.login.toLowerCase() === cfg.owner.toLowerCase() ? r.name : r.full_name, fullName: full, owner: r.owner.login, client: (cfg.clientOwners ?? []).includes(r.owner.login), url: r.html_url, private: r.private, description: r.description,
    kind: r.kind ?? "active", fork,
    defaultBranch: branch, pushedAt: r.pushed_at, language: r.language, topics: r.topics ?? [],
    readable, hasAgents: readable ? !!agents : null, latestRelease: release ? { tag: release.tag_name, published: release.published_at, url: release.html_url } : null,
    prs, issues: realIssues, updates,
    failingWorkflows: failing.map((x) => ({ name: x.name, url: x.html_url, at: x.updated_at })),
    dependabot: (dependabot ?? []).map((a) => ({ id: a.number, severity: sev(a), pkg: a.dependency?.package?.name, ecosystem: a.dependency?.package?.ecosystem, ghsa: a.security_advisory?.ghsa_id, summary: a.security_advisory?.summary, url: a.html_url })),
    codeScanning: (codeScan ?? []).map((a) => ({ id: a.number, severity: sev(a), rule: a.rule?.id, url: a.html_url })),
    secretScanning: (secretScan ?? []).map((a) => ({ id: a.number, type: a.secret_type_display_name || a.secret_type, url: a.html_url })),
  };
}

async function projects() {
  // Org Projects need Organization permissions → Projects: read. Personal (user-owned) Projects are tried,
  // but GitHub may refuse them to app and fine-grained tokens; a refusal shows under "Couldn't check".
  const out = [];
  for (const o of cfg.owners ?? []) {
    if (!tokenFor(o) && !USE_GH) continue;
    const kind = o.toLowerCase() === cfg.owner.toLowerCase() ? "user" : "organization";
    const data = await graphql(`query($login:String!){ ${kind}(login:$login){ projectsV2(first:30, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ title url closed updatedAt items(first:100){ totalCount nodes{ fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } } }`, { login: o }, o);
    const node = data?.[kind];
    if (!node) continue;
    for (const p of node.projectsV2.nodes.filter((p) => !p.closed)) {
      const counts = {};
      for (const it of p.items.nodes) { const st = it.fieldValueByName?.name ?? "No status"; counts[st] = (counts[st] ?? 0) + 1; }
      out.push({ owner: o, title: p.title, url: p.url, updatedAt: p.updatedAt, items: p.items.totalCount, byStatus: counts });
    }
  }
  return out;
}

// Summarise the latest run of each workflow on one commit: green, red, pending, or none (no runs).
export function checksState(runs) {
  const latest = new Map();
  for (const run of runs) {
    const prev = latest.get(run.workflow_id);
    if (!prev || new Date(run.created_at) > new Date(prev.created_at)) latest.set(run.workflow_id, run);
  }
  const all = [...latest.values()];
  if (!all.length) return "none";
  if (all.some((x) => x.status !== "completed")) return "pending";
  if (all.some((x) => !["success", "skipped", "neutral"].includes(x.conclusion))) return "red";
  return "green";
}

// ---------- Analyse ----------
const SEV_RANK = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1, note: 0, warning: 1, error: 3, unknown: 0 };
const days = (iso) => Math.floor((now - new Date(iso)) / 86400e3);
const isNew = (iso) => iso && new Date(iso) >= since;

export function analyse(repos, prev, noise = []) {
  const prevAlerts = new Set();
  for (const r of prev?.repos ?? []) {
    for (const a of r.dependabot ?? []) prevAlerts.add(`${r.name}#d${a.id}`);
    for (const a of r.codeScanning ?? []) prevAlerts.add(`${r.name}#c${a.id}`);
    for (const a of r.secretScanning ?? []) prevAlerts.add(`${r.name}#s${a.id}`);
  }
  const needs = [];
  for (const r of repos) {
    for (const s of r.secretScanning) needs.push({ rank: 100, text: `**${r.name}**: exposed secret (${s.type}). Rotate it, then close the alert. [alert](${s.url})` });
    const sevAlerts = [...r.dependabot, ...r.codeScanning].filter((a) => SEV_RANK[a.severity] >= 3);
    const fresh = sevAlerts.filter((a) => !prevAlerts.has(`${r.name}#${a.pkg !== undefined ? "d" : "c"}${a.id}`));
    if (sevAlerts.length) needs.push({ rank: 80 + (fresh.length ? 5 : 0), text: `**${r.name}**: ${sevAlerts.length} critical/high security alert(s)${fresh.length && prev ? `, ${fresh.length} new` : ""}. [alerts](${r.url}/security)` });
    for (const w of r.failingWorkflows) needs.push({ rank: 70, text: `**${r.name}**: \`${w.name}\` failing on ${r.defaultBranch}. [run](${w.url})` });
    const human = r.prs.filter((p) => !p.bot && !p.draft);
    for (const p of human.slice(0, cfg.maxPrsListed)) needs.push({ rank: 60 - Math.min(days(p.created), 30) / 100, text: `**${r.name}**: PR #${p.number} "${p.title}" open ${days(p.created)}d. [PR](${p.url})` });
  }
  // An exposed secret is never noise: it's live wherever the repo is readable, archived or not.
  for (const r of noise) for (const s of r.secretScanning) needs.push({ rank: 100, text: `**${r.name}** (${r.kind}): exposed secret (${s.type}). Rotate it, then close the alert. [alert](${s.url})` });
  needs.sort((a, b) => b.rank - a.rank);

  const changed = [];
  for (const r of repos) {
    for (const i of r.issues.filter((i) => isNew(i.created))) changed.push(`**${r.name}**: new issue #${i.number} "${i.title}". [link](${i.url})`);
    for (const p of r.prs.filter((p) => isNew(p.created))) changed.push(`**${r.name}**: new PR #${p.number} "${p.title}"${p.updater ? ` (${p.updater})` : p.bot ? " (bot)" : ""}. [link](${p.url})`);
    if (r.latestRelease && isNew(r.latestRelease.published)) changed.push(`**${r.name}**: released ${r.latestRelease.tag}. [link](${r.latestRelease.url})`);
  }

  const drift = {
    stale: repos.filter((r) => days(r.pushedAt) > cfg.staleDays).map((r) => `${r.name} (${days(r.pushedAt)}d)`),
    botPrPiles: repos.map((r) => {
      const bots = r.prs.filter((p) => p.bot);
      const by = ["renovate", "dependabot"].map((u) => [u, bots.filter((p) => p.updater === u).length]).filter(([, n]) => n);
      const other = bots.length - by.reduce((n, [, c]) => n + c, 0);
      if (other) by.push(["other bots", other]);
      const dash = r.updates?.dashboard ? `, [dashboard](${r.updates.dashboard})` : "";
      return bots.length >= 3 ? `${r.name} (${by.map(([u, c]) => `${u} ${c}`).join(", ")}${dash})` : null;
    }).filter(Boolean),
    updaters: {
      renovate: repos.filter((r) => r.updates && r.updates.tools.length === 1 && r.updates.tools[0] === "renovate").map((r) => r.name),
      dependabot: repos.filter((r) => r.updates && r.updates.tools.length === 1 && r.updates.tools[0] === "dependabot").map((r) => r.name),
      both: repos.filter((r) => r.updates?.tools.length === 2).map((r) => r.name),
      none: repos.filter((r) => r.updates && r.updates.tools.length === 0).map((r) => r.name),
    },
    noAgents: repos.filter((r) => r.hasAgents === false).map((r) => r.name),
    oldPrs: repos.flatMap((r) => r.prs.filter((p) => !p.bot && days(p.updated) > 30).map((p) => `${r.name}#${p.number} (${days(p.updated)}d quiet)`)),
  };

  // Patterns: the same vulnerable package across repos, the same failing workflow name across repos
  const byPkg = new Map();
  for (const r of repos) for (const a of r.dependabot) {
    const k = `${a.ecosystem}:${a.pkg}`;
    if (!byPkg.has(k)) byPkg.set(k, { pkg: a.pkg, eco: a.ecosystem, repos: new Set(), worst: 0 });
    const e = byPkg.get(k); e.repos.add(r.name); e.worst = Math.max(e.worst, SEV_RANK[a.severity] ?? 0);
  }
  const byWf = new Map();
  for (const r of repos) for (const w of r.failingWorkflows) {
    const k = w.name.toLowerCase();
    if (!byWf.has(k)) byWf.set(k, { name: w.name, repos: [] });
    byWf.get(k).repos.push(r.name);
  }
  const patternData = {
    packages: [...byPkg.values()].filter((e) => e.repos.size >= 2).sort((a, b) => b.repos.size - a.repos.size || b.worst - a.worst)
      .map((e) => ({ pkg: e.pkg, ecosystem: e.eco, repos: [...e.repos], worst: Object.keys(SEV_RANK).find((k) => SEV_RANK[k] === e.worst) ?? "unknown" })),
    workflows: [...byWf.values()].filter((e) => e.repos.length >= 2),
  };
  const patterns = [
    ...[...byPkg.values()].filter((e) => e.repos.size >= 2).sort((a, b) => b.repos.size - a.repos.size || b.worst - a.worst)
      .map((e) => `\`${e.pkg}\` (${e.eco}) has open alerts in ${e.repos.size} repos: ${[...e.repos].join(", ")}. One upgrade pass could clear them all.`),
    ...[...byWf.values()].filter((e) => e.repos.length >= 2).map((e) => `\`${e.name}\` is failing in ${e.repos.length} repos: ${e.repos.join(", ")}. Probably one shared cause.`),
  ];

  const goals = Object.entries(cfg.goalRepos).map(([goal, names]) => {
    const rs = repos.filter((r) => names.some((n) => [r.name.toLowerCase(), r.name.split("/").pop().toLowerCase()].includes(n.toLowerCase())));
    if (!rs.length) return `${goal}: no matching repo found (check radar.config.json).`;
    return `${goal}: ` + rs.map((r) => `${r.name}: ${r.prs.length} open PR(s), ${r.issues.length} issue(s), ${r.failingWorkflows.length ? "CI failing" : "CI ok"}, last push ${days(r.pushedAt)}d ago`).join("; ");
  });

  return { needs, changed, drift, patterns, patternData, goals, noise: noiseOf(noise) };
}

// Noise: archived and forked repos that still raise alerts, bot PRs or CI runs, each with ways to deal with it.
// The recommended option comes first. Options are suggestions for the owner; the radar never acts on them.
export function noiseOf(repos) {
  const out = [];
  for (const r of repos) {
    const bots = r.prs.filter((p) => p.bot);
    const alerts = r.dependabot.length + r.codeScanning.length;
    const critHigh = [...r.dependabot, ...r.codeScanning].filter((a) => SEV_RANK[a.severity] >= 3).length;
    const dependabotConfig = !!r.updates?.configured.includes("dependabot");
    // An archived repo runs no workflows, so a red last run there is history, not noise.
    const failing = r.kind === "archived" ? 0 : r.failingWorkflows.length;
    const signals = { alerts, critHigh, botPrs: bots.length, failing, dependabotConfig, secrets: r.secretScanning.length };
    if (!alerts && !bots.length && !failing && !dependabotConfig && !signals.secrets) continue;
    const options = [];
    if (r.kind === "archived") {
      const silence = { id: "silence-alerts", kind: "silence", label: "Turn off Dependabot alerts", effect: "Stops alerts on a repo nobody ships from. Nothing else changes.", how: `gh api -X DELETE repos/${r.fullName ?? r.name}/vulnerability-alerts` };
      const del = { id: "delete", kind: "remove", label: "Delete the repo", effect: "Removes it and all its noise for good. Mirror-clone it first if you might want it back.", how: `git clone --mirror ${r.url}.git && gh repo delete ${r.fullName ?? r.name}` };
      const fix = { id: "fix-and-rearchive", kind: "remediate", label: "Unarchive, tidy, re-archive", effect: "Close the stale bot PRs and remove dependabot.yml (an archived repo is read-only, so they can't be closed as it is), then archive again.", how: "hand off" };
      // Alerts are what keep arriving, so silence those first; without alerts, the noise is stale PRs or config.
      if (alerts) options.push(silence, del, fix);
      else options.push(fix, del);
    } else {
      const ahead = r.fork?.ahead;
      const own = ahead == null ? null : ahead > 0;
      const del = { id: "delete", kind: "remove", label: "Delete the fork", effect: own === false ? "It holds no commits of yours, so nothing is lost." : own ? `It holds ${ahead} commit(s) of yours: push them upstream or keep a mirror first.` : "Check it holds nothing of yours first.", how: `gh repo delete ${r.fullName ?? r.name}` };
      const silence = { id: "silence-fork", kind: "silence", label: "Turn off alerts and Actions on the fork", effect: "Keeps the fork, stops its alerts and scheduled runs.", how: `gh api -X DELETE repos/${r.fullName ?? r.name}/vulnerability-alerts && gh api -X PUT repos/${r.fullName ?? r.name}/actions/permissions -F enabled=false` };
      const sync = { id: "sync-upstream", kind: "remediate", label: "Sync with upstream", effect: `Brings in the parent's fixes${r.fork?.behind ? ` (${r.fork.behind} commits behind)` : ""}, which usually clears inherited alerts.`, how: `gh repo sync ${r.fullName ?? r.name}` };
      const promote = { id: "promote", kind: "remediate", label: "Treat as an active repo", effect: "Adds it to activeForks in radar.config.json, so it gets the full report.", how: "radar.config.json: activeForks" };
      if (own === false) options.push(del, sync, silence);
      else if (own) options.push(promote, silence, del);
      else options.push(silence, sync, del);
    }
    out.push({ name: r.name, fullName: r.fullName ?? r.name, kind: r.kind, url: r.url, client: r.client, pushedAt: r.pushedAt, fork: r.fork ?? null, signals, recommended: options[0].id, options });
  }
  return out.sort((a, b) => b.signals.secrets - a.signals.secrets || b.signals.critHigh - a.signals.critHigh || b.signals.alerts + b.signals.botPrs - (a.signals.alerts + a.signals.botPrs));
}

// ---------- Dashboard view model ----------
// data/dashboard.json: a compact, stable shape for the dashboard artifact. It carries its own history
// (one totals row per day, newest last, at most HISTORY_DAYS) forward from the previous file.
const HISTORY_DAYS = 60;
export function totalsOf(repos, noiseCount = 0) {
  const sum = (f) => repos.reduce((n, r) => n + f(r), 0);
  return {
    repos: repos.length, private: repos.filter((r) => r.private).length,
    prs: sum((r) => r.prs.length), humanPrs: sum((r) => r.prs.filter((p) => !p.bot).length), botPrs: sum((r) => r.prs.filter((p) => p.bot).length),
    issues: sum((r) => r.issues.length),
    alerts: sum((r) => r.dependabot.length + r.codeScanning.length + r.secretScanning.length),
    critHigh: sum((r) => [...r.dependabot, ...r.codeScanning].filter((a) => SEV_RANK[a.severity] >= 3).length),
    secrets: sum((r) => r.secretScanning.length),
    failing: repos.filter((r) => r.failingWorkflows.length).length,
    noAgents: repos.filter((r) => r.hasAgents === false).length,
    stale: repos.filter((r) => days(r.pushedAt) > cfg.staleDays).length,
    noise: noiseCount,
  };
}

// Priority 0-100 (higher = needs you sooner) and the worst signal's level, which the dashboard maps to
// distance from the radar's centre and colour.
export function priorityOf(r) {
  const critHigh = [...r.dependabot, ...r.codeScanning].filter((a) => SEV_RANK[a.severity] >= 3).length;
  const human = r.prs.filter((p) => !p.bot && !p.draft).length;
  const bots = r.prs.filter((p) => p.bot).length;
  if (r.readable === false) return { score: 0, level: "unknown" };
  if (r.secretScanning.length) return { score: 100, level: "secret" };
  if (critHigh) return { score: Math.min(95, 75 + critHigh / 2), level: "critical" };
  if (r.failingWorkflows.length) return { score: 60 + Math.min(10, r.failingWorkflows.length * 2), level: "ci" };
  if (human) return { score: 45 + Math.min(10, human * 2), level: "prs" };
  if (bots >= 3 || r.dependabot.length) return { score: 25 + Math.min(15, bots + r.dependabot.length / 4), level: "drift" };
  if (days(r.pushedAt) > cfg.staleDays) return { score: 8, level: "stale" };
  return { score: 3, level: "ok" };
}

export function dashboard(repos, a, { generated = now.toISOString(), warnings: warn = [], projects: proj = [], prev = null, seed = null } = {}) {
  const totals = totalsOf(repos, a.noise?.length ?? 0);
  const date = generated.slice(0, 10);
  let history = prev?.history ?? [];
  if (!history.length && seed?.repos) history = [{ date: (seed.generated ?? "").slice(0, 10), ...totalsOf(seed.repos, (seed.noise ?? []).length) }];
  history = [...history.filter((h) => h.date !== date), { date, ...totals }].slice(-HISTORY_DAYS);
  const prevScore = new Map((prev?.repos ?? []).map((r) => [r.fullName, r.score]));
  const goalsOf = (r) => Object.entries(cfg.goalRepos ?? {}).filter(([, ns]) => ns.some((n) => [r.name.toLowerCase(), r.name.split("/").pop().toLowerCase()].includes(n.toLowerCase()))).map(([g]) => g);
  return {
    schema: 1, generated, owner: cfg.owner, staleDays: cfg.staleDays, totals, history,
    repos: repos.map((r) => {
      const { score, level } = priorityOf(r);
      const bots = r.prs.filter((p) => p.bot);
      const full = r.fullName ?? (r.name.includes("/") ? r.name : `${r.owner}/${r.name}`);
      return {
        name: r.name, fullName: full, owner: r.owner, client: r.client, url: r.url, private: r.private,
        description: r.description ?? null, language: r.language ?? null, pushedAt: r.pushedAt, staleDays: days(r.pushedAt),
        readable: r.readable, hasAgents: r.hasAgents, release: r.latestRelease, goals: goalsOf(r),
        score, level, fresh: prev ? score > (prevScore.get(full) ?? -1) || r.prs.some((p) => isNew(p.created)) : false,
        alerts: {
          secrets: r.secretScanning.map((s) => ({ type: s.type, url: s.url })),
          critHigh: [...r.dependabot, ...r.codeScanning].filter((x) => SEV_RANK[x.severity] >= 3).length,
          total: r.dependabot.length + r.codeScanning.length,
          packages: [...new Set(r.dependabot.filter((x) => SEV_RANK[x.severity] >= 3).map((x) => x.pkg))].slice(0, 12),
        },
        failing: r.failingWorkflows,
        humanPrs: r.prs.filter((p) => !p.bot).map((p) => ({ number: p.number, title: p.title, url: p.url, draft: p.draft, author: p.author, created: p.created, updated: p.updated, headSha: p.headSha ?? null, checks: p.checks ?? null })),
        botPrs: { renovate: bots.filter((p) => p.updater === "renovate").length, dependabot: bots.filter((p) => p.updater === "dependabot").length, other: bots.filter((p) => !p.updater).length },
        issues: r.issues.length,
        updaters: r.updates ? { tools: r.updates.tools, configured: r.updates.configured, dashboard: r.updates.dashboard } : null,
      };
    }).sort((x, y) => y.score - x.score || x.name.localeCompare(y.name)),
    needs: a.needs.slice(0, 40).map((n) => n.text),
    changed: a.changed,
    patterns: a.patternData ?? { packages: [], workflows: [] },
    updaters: a.drift.updaters,
    goals: Object.entries(cfg.goalRepos ?? {}).map(([goal, names]) => ({ goal, repos: names })),
    noise: a.noise ?? [],
    projects: proj ?? [],
    warnings: warn,
  };
}

// ---------- Render ----------
export function render(repos, a, proj) {
  const L = [];
  const totals = {
    prs: repos.reduce((n, r) => n + r.prs.length, 0),
    issues: repos.reduce((n, r) => n + r.issues.length, 0),
    alerts: repos.reduce((n, r) => n + r.dependabot.length + r.codeScanning.length + r.secretScanning.length, 0),
    failing: repos.filter((r) => r.failingWorkflows.length).length,
  };
  L.push(`# Portfolio radar: ${today}`, "");
  const noisy = a.noise ?? [];
  L.push(`${repos.length} active repos (${repos.filter((r) => r.private).length} private). ${totals.prs} open PRs, ${totals.issues} open issues, ${totals.alerts} open security alerts, ${totals.failing} repos with CI failing on their default branch.${noisy.length ? ` Plus ${noisy.length} archived or forked repos still making noise (section 6).` : ""}`, "");
  L.push("## 1. Needs you today", "");
  L.push(...(a.needs.length ? a.needs.slice(0, 25).map((n) => `- ${n.text}`) : ["- Nothing urgent."]));
  if (a.needs.length > 25) L.push(`- …and ${a.needs.length - 25} more in data/latest.json.`);
  L.push("", `## 2. Changed in the last ${cfg.lookbackHours} hours`, "");
  L.push(...(a.changed.length ? a.changed.map((c) => `- ${c}`) : ["- No new issues, PRs or releases."]));
  L.push("", "## 3. Drift", "");
  L.push(`- No push in ${cfg.staleDays}+ days (${a.drift.stale.length}): ${a.drift.stale.join(", ") || "none"}`);
  L.push(`- Bot PRs piling up (3+), ready to fold into one branch or let automerge take: ${a.drift.botPrPiles.join("; ") || "none"}`);
  const u = a.drift.updaters;
  L.push(`- Dependency updates: ${u.renovate.length} repos on Renovate, ${u.dependabot.length} on Dependabot, ${u.both.length} on both, ${u.none.length} on neither`);
  if (u.both.length) L.push(`  - Both Renovate and Dependabot (duplicate PRs likely; keep one, or keep Dependabot for security updates only): ${u.both.join(", ")}`);
  if (u.none.length) L.push(`  - No dependency updater: ${u.none.join(", ")}`);
  L.push(`- PRs quiet for 30+ days: ${a.drift.oldPrs.join(", ") || "none"}`);
  L.push(`- Missing AGENTS.md (${a.drift.noAgents.length}): ${a.drift.noAgents.join(", ") || "none"}`);
  L.push("", "## 4. Patterns across repos", "");
  L.push(...(a.patterns.length ? a.patterns.map((p) => `- ${p}`) : ["- None today."]));
  L.push("", "## 5. Toward your goals", "");
  L.push(...a.goals.map((g) => `- ${g}`));
  L.push("", "## 6. Noise: archived and forked repos", "");
  if (!noisy.length) L.push("- None: no archived or forked repo is raising alerts or bot PRs.");
  for (const n of noisy) {
    const s = n.signals;
    const what = [s.secrets && `${s.secrets} exposed secret(s)`, s.alerts && `${s.alerts} alert(s)${s.critHigh ? ` (${s.critHigh} critical/high)` : ""}`, s.botPrs && `${s.botPrs} bot PR(s)`, s.failing && `${s.failing} failing workflow(s)`, s.dependabotConfig && "Dependabot still configured"].filter(Boolean).join(", ");
    const fork = n.fork ? ` Fork of ${n.fork.parent ?? "unknown"}${n.fork.ahead != null ? `, ${n.fork.ahead} ahead / ${n.fork.behind} behind` : ""}.` : "";
    const rec = n.options[0];
    L.push(`- **${n.name}** (${n.kind}): ${what}.${fork} Suggested: ${rec.label.toLowerCase()} (${rec.effect}) Other options: ${n.options.slice(1).map((o) => o.label.toLowerCase()).join("; ")}. [repo](${n.url})`);
  }
  if (proj?.length) {
    L.push("", "## GitHub Projects", "");
    for (const p of proj) L.push(`- ${p.owner}: [${p.title}](${p.url}): ${p.items} items (${Object.entries(p.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}), updated ${days(p.updatedAt)}d ago`);
  }
  if (warnings.size) L.push("", "## Couldn't check", "", ...[...warnings].map((w) => `- ${w}`));
  L.push("", "_Generated by portfolio-radar. Read-only: it never changes a repo._", "");
  return L.join("\n");
}

// ---------- Main ----------
async function main() {
if (process.env.RADAR_APP_ID && process.env.RADAR_APP_PRIVATE_KEY) {
  await mintAppTokens(process.env.RADAR_APP_ID, process.env.RADAR_APP_PRIVATE_KEY);
}
if (!APP && !TOKEN && !USE_GH && !OWNERS.some((o) => process.env[envName(o)])) {
  console.error("No token found. Set RADAR_TOKEN or RADAR_TOKEN_<OWNER>, or RADAR_USE_GH=1 (see docs/setup.md).");
  process.exit(1);
}
const prevPath = join(root, "data", "latest.json");
const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
let repos = await listRepos();
if (LIMIT) repos = repos.slice(0, LIMIT);
const collected = [];
for (let i = 0; i < repos.length; i += 6) {
  collected.push(...(await Promise.all(repos.slice(i, i + 6).map((r) => collect(r).catch((e) => {
    // One repo failing must not sink the whole report: note it and carry on.
    warnings.add(`${r.full_name}: couldn't be read (${e.message}).`);
    return null;
  })))).filter(Boolean));
}
const proj = await projects();
const active = collected.filter((r) => r.kind === "active");
const noise = collected.filter((r) => r.kind !== "active");
const analysis = analyse(active, prev, noise);
const md = render(active, analysis, proj);

mkdirSync(join(root, "reports"), { recursive: true });
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "reports", `${today}.md`), md);
writeFileSync(join(root, "reports", "latest.md"), md);
const snapshot = { generated: now.toISOString(), owner: cfg.owner, repos: active, noise, projects: proj ?? null, warnings: [...warnings] };
writeFileSync(join(root, "data", `${today}.json`), JSON.stringify(snapshot, null, 2));
writeFileSync(prevPath, JSON.stringify(snapshot, null, 2));
const dashPath = join(root, "data", "dashboard.json");
const prevDash = existsSync(dashPath) ? JSON.parse(readFileSync(dashPath, "utf8")) : null;
writeFileSync(dashPath, JSON.stringify(dashboard(active, analysis, { generated: now.toISOString(), warnings: [...warnings], projects: proj, prev: prevDash, seed: prev })));
console.log(`Radar: ${active.length} active repos, ${noise.length} archived or forked, ${analysis.needs.length} need attention.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
