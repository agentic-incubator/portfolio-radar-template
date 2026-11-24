# How it works

## The daily run

`.github/workflows/daily-radar.yml` runs at 11:23 UTC (3:23am Pacific in winter, 4:23am in summer), or on demand from the Actions tab.

1. **Mint tokens.** The script signs a short JWT with the app's private key (`node:crypto`, no libraries), lists the app's installations (`GET /app/installations`), and mints one read-only installation token per owner in `radar.config.json` (`POST /app/installations/{id}/access_tokens`). Tokens last one hour and live only in memory during the run. A configured owner without an install shows up under "Couldn't check", and so does an install on an owner that isn't in the config.
2. **List repos.** For each owner, the script calls `GET /installation/repositories` with that owner's token. It respects `includePrivate` and drops anything in `ignoreRepos`. Each repo is then active, archived or a fork. Archived repos and forks are checked the same way but kept apart as **noise** (section 6 of the report), because GitHub can still raise alerts and bot PRs on them. A fork named in `activeForks` counts as active. `noise.archived` or `noise.forks` set to `false` leaves that kind out entirely.
3. **Collect.** For each repo, six at a time, it reads:

   | Check | API | App permission (read) |
   |---|---|---|
   | Open PRs | `/repos/{r}/pulls?state=open` | Pull requests |
   | Open issues | `/repos/{r}/issues?state=open` | Issues |
   | CI on default branch | `/repos/{r}/actions/runs?branch=…` | Actions |
   | Dependabot alerts | `/repos/{r}/dependabot/alerts` | Dependabot alerts |
   | Code scanning | `/repos/{r}/code-scanning/alerts` | Code scanning alerts |
   | Secret scanning | `/repos/{r}/secret-scanning/alerts` | Secret scanning alerts |
   | Releases (latest, asset download counts) | `/repos/{r}/releases` | Contents |
   | AGENTS.md present | `/repos/{r}/contents/AGENTS.md` | Contents |
   | Renovate / Dependabot config | `/repos/{r}/contents` and `/contents/.github` (file names only) | Contents |
   | Repo list, push date | `/installation/repositories` | Metadata |
   | CI on open PRs | `/repos/{r}/actions/runs?head_sha=…` for each non-draft human PR (up to `maxPrsListed`) | Actions |
   | Fork's parent, commits ahead/behind | `/repos/{r}` and `/repos/{r}/compare/{parent}:{branch}...{owner}:{branch}` (forks only) | Metadata, Contents |
   | GitHub Projects (org) | GraphQL `organization.projectsV2` | Organization → Projects |
   | Metrics (active repos) | See [Metrics](#metrics) below | Metadata, Contents, Pull requests |

   A PR's CI state comes from the latest Actions run of each workflow on its head commit: green (all passed or skipped), red, pending, or none. Checks from other apps aren't read, because that would need the Checks permission; the dashboard's Ship it action checks the full status again before merging.
   A 403/404 on one check never fails the run. The radar keeps GitHub's reason and sorts it: when the feature is switched off or not set up for that repo ("Dependabot alerts are disabled", "no analysis found", "Secret scanning is disabled"), the repo goes on a *Turned off* line and in `coverage` in `data/dashboard.json` (active repos only, each with `private`), with what it takes to turn it on. Any other refusal (the app lacks the permission or isn't installed) stays a *not readable* gap. Either way it's never shown as zero alerts.
   For each open Dependabot alert the radar also keeps the advisory's affected range (`range`), first patched version (`patched`) and manifest path (`manifest`). `data/dashboard.json` groups them per package as `alerts.advisories`: `{ pkg, ecosystem, severity, fixedIn, noFix, ghsa, ranges, manifests }`, where `fixedIn` is the highest first-patched version across that package's alerts and `noFix` lists advisories with no patched release yet. The dashboard's Sweep sends these with the request, so the session that opens the PRs doesn't need to read alerts itself.
   Which dependency updater a repo uses comes from three signals: a Renovate config file (`renovate.json`, `renovate.json5`, `.renovaterc`, `.renovaterc.json`, `.renovaterc.json5` at the root, or `renovate.json(5)` in `.github/`), a `.github/dependabot.yml`, and who opened the open PRs (`renovate[bot]`, a self-hosted `renovate-*` user, or `dependabot[bot]`). Renovate's "Dependency Dashboard" issue also counts, which catches Renovate configured inside `package.json`. Dependabot *alerts* are GitHub's vulnerability alerts and are read for every repo whichever updater it uses.
4. **Metrics.** For each active repo, the numbers in section 7 of the report. See [Metrics](#metrics).
5. **Analyse.** It ranks findings (see [Reading the report](reading-the-report.md)) and compares today's alerts with `data/latest.json` from the last run, so newly opened alerts are called out.
6. **Write.** `reports/YYYY-MM-DD.md`, `reports/latest.md`, `data/YYYY-MM-DD.json`, `data/latest.json` (active repos under `repos`, archived and forked ones under `noise`), and `data/dashboard.json`, the compact view the dashboard artifact reads. It keeps one totals row per day for the last 60 days, carried forward from the previous file.
7. **Commit.** The workflow commits `reports/` and `data/` as `portfolio-radar` with `chore(report): daily radar <date>`. This uses the workflow's own `GITHUB_TOKEN`, not the app.

## Metrics

Per active repo, stored as `metrics` in `data/latest.json` and shown in section 7 of the report. Anything that can't be read is `null`, shows as "?" and is named under "Couldn't check". It is never shown as 0.

| Metric | Meaning | Source | Refresh |
|---|---|---|---|
| `created` | When the repo was created on GitHub | Repo record (no extra call) | Daily |
| `lastCommit` | Newest commit on the default branch (`pushedAt` counts any branch) | `/repos/{r}/commits?sha={branch}&per_page=1`, skipped when nothing was pushed since the last run | Daily |
| `stars` | Stargazers | Repo record | Daily |
| `openIssues` | Open issues, not counting PRs | The open issue list already read | Daily |
| `prsClosed` | Every PR ever closed, merged or not | The `rel="last"` page of `/repos/{r}/pulls?state=closed&per_page=1` | Daily |
| `prsMerged` | Every PR ever merged | Search `repo:{r} is:pr is:merged` (30 searches a minute, so they queue about 2 seconds apart) | Weekly |
| `forks.total` / `forks.active` | All direct forks / forks whose owner pushed after forking, last push within `metrics.activeForkMonths` months | Repo record / `/repos/{r}/forks` (only when there are forks) | Daily / weekly |
| `loc` | Non-blank lines in tracked source files, total and by language. With `metrics.loc` set to `false` it isn't counted and the column is left out | A shallow clone of the default branch into a temp folder, removed afterwards | Weekly |
| `downloads` | Release file downloads plus package downloads, for the last 1, 7, 30 and 182 days (`d1`, `d7`, `d30`, `d182`) | See below | Daily |

Weekly fields refresh on `metrics.weekday` (UTC, 1 = Monday), on the first run, or when you run with `RADAR_WEEKLY=1`. In between they're carried forward from the last snapshot, and `weeklyAt` says when they were measured.

**Lines of code** count files in a programming, markup or stylesheet language (by extension). They skip Markdown, JSON, YAML and other data; files over 1 MB; minified, bundled and lock files; `node_modules/`, `vendor/`, `third_party/`, `dist/`, `build/`, `target/` and similar folders; and paths marked `linguist-vendored` or `linguist-generated` in `.gitattributes`. Comments count as lines. The clone uses the owner's read-only token through a git header, never in the URL.

**Downloads.** GitHub has no single download number, and its clone and view traffic needs a write-level permission and keeps only 14 days, so it isn't used. The radar adds up:

| Source | What it gives | How the windows are filled |
|---|---|---|
| GitHub release assets | Lifetime count per file | Today's total minus the total in an earlier `data/<date>.json` snapshot |
| npm (`api.npmjs.org`) | Daily counts, up to 18 months | Read directly |
| crates.io | Daily counts for 90 days, plus a lifetime total | 1, 7 and 30 days directly; 182 days from snapshots |
| PyPI (`pypistats.org`, without mirrors) | Daily counts for 180 days | Read directly |
| Docker Hub | Lifetime pull count | From snapshots |

A package counts for a repo only when its registry entry points back to that repo (npm `repository`, `homepage` or `bugs`; crates.io `repository` or `homepage`; PyPI project URLs), so a name clash can't borrow someone else's downloads. Once a week the radar looks for packages in the root `package.json` (unless `private`), `Cargo.toml` (`[package]`, unless `publish = false`) and `pyproject.toml`, and keeps the ones that link back (`downloads.packages.verified`; the rest are listed as `unverified`). Workspace members aren't followed: add them, or a Docker Hub image, under `metrics.packages`.

Snapshot windows need a snapshot that old. For each window the base is the newest snapshot on or before the window's first day; if there isn't one, the oldest snapshot after it, and the window is labelled "since" that date (`downloads.partialSince`). A missed daily run can do the same in the other direction (the base is older than the window), and the label shows it. A total that went down (a release or file was deleted) makes the window unknown. When sources cover different spans, the label shows the shortest. A repo with no release files and no packages shows "-".

## Weekly flow

What got done across the whole estate each week, stored as `weekly` in `data/dashboard.json` and shown as cards on the dashboard's Overview. One row per week (Monday to Sunday, UTC), 12 weeks, the newest being the week in progress (`partial: true`):

| Field | Meaning | Source |
|---|---|---|
| `prsMerged` | PRs merged in the week, in active (not archived) repos of every readable owner | GitHub search, `is:pr is:merged merged:<week>` |
| `botPrsMerged` | Of those, merged from Renovate or Dependabot | The same search with `author:app/renovate` and `author:app/dependabot` |
| `issuesClosed` | Issues closed in the week | `is:issue is:closed closed:<week>` |
| `issuesOpened` | Issues opened in the week | `is:issue created:<week>` |

Search counts by date, so the first run backfills all 12 weeks (about 5 searches per owner per week; search allows 30 a minute, so the first run takes several minutes). After that each run fetches only the two newest weeks and carries the rest forward. A count that can't be read is `null`, shows as "?" and is named under "Couldn't check"; a good value from an earlier run is kept rather than replaced by a gap.

Only owners the radar can read are counted. An owner where the GitHub App isn't installed yet (a client org waiting on its owner, say) is left out and named under "Couldn't check", instead of turning every count into "?". Each row stores the owners it counts in `owners`; when that set changes (the app gets installed), the old weeks are fetched again so the series stays comparable. With no readable owner at all, `weekly` is `null` and the dashboard shows no flow cards.

Turn it off with `"weekly": { "enabled": false }` in `radar.config.json`, or change the number of weeks with `"weekly": { "weeks": 8 }`.

The health cards come from the daily `history` totals, which now also carry `renovateOnly` (repos whose only update bot is Renovate) and `prAgeMedian` (median age in days of open, non-draft people's PRs; `null` when there are none).

## Auth in one picture

```
RADAR_APP_ID + RADAR_APP_PRIVATE_KEY   (2 repo secrets, set once, never expire)
        │  sign JWT, GET /app/installations
        ├─ install on your account      → token for your account
        ├─ install on your-org         → token for your-org
        ├─ install on …                 → token for …
        └─ install on <client org>      → token for <client org>
                 (1-hour installation tokens, read-only, in memory only)
```

The script picks a token by the owner in each API path (`/repos/<owner>/…`, `/orgs/<owner>/…`). Internally each token is held as `RADAR_TOKEN_<OWNER>` (owner uppercased, anything that isn't a letter or digit turned into `_`), which is also how you pass tokens by hand for a local run.

Onboarding an owner is therefore: install the app there and add the name to `radar.config.json` (`scripts/add-owner.sh` does the second part). Nothing in the workflow or secrets changes.

### Why a GitHub App and not personal tokens

Fine-grained personal tokens cover one owner each, expire (a year at most), and can't be created from a script, so renewal means clicking through GitHub's UI once per owner. A GitHub App has one private key that doesn't expire, gets a fresh short-lived token per run, and is installed once per owner. A client org can install it with read-only access without you holding any of their credentials, and can remove it at any time.

## Modes

| Mode | How to run | Repo listing | Notes |
|---|---|---|---|
| App (Actions) | `RADAR_APP_ID` + `RADAR_APP_PRIVATE_KEY` | `/installation/repositories` | The normal daily run. Works locally too |
| Token (local) | `RADAR_TOKEN=…` (optionally `RADAR_TOKEN_<OWNER>`) | `/user/repos` for a personal account, `/orgs/{o}/repos` for an org (decided by account type) | Any read-only PAT |
| gh CLI (local) | `RADAR_USE_GH=1` | `gh api search/repositories` | Uses your gh login. No GitHub Projects (GraphQL is skipped) |

`RADAR_LIMIT=N` checks only the first N repos, handy for a quick local test. Local runs write to `reports/` and `data/` too, so don't commit them by accident.

## Configuration (`radar.config.json`)

| Key | Meaning |
|---|---|
| `owner` | The main account: your personal login, or for a team radar the team's org. Its repos show by name alone; others show as `owner/name`. It must also be in `owners` |
| `owners` | Accounts and orgs you run |
| `clientOwners` | Client orgs. Checked the same way, marked as client work |
| `includePrivate` | Include private repos |
| `staleDays` | No push for this many days counts as drift |
| `lookbackHours` | Window for "changed" |
| `maxPrsListed` | Max human PRs per repo in "needs you" |
| `goalRepos` | Goal name → repo names to track in section 5 |
| `ignoreRepos` | Repo names to skip |
| `noise` | `{ "archived": true, "forks": true }`: include archived repos and forks as noise. `false` leaves that kind out |
| `activeForks` | Forks that are really your own work (`name` or `owner/name`): reported as active repos |
| `metrics` | Optional. `enabled` (default `true`), `weekday` for the weekly fields (UTC, 0 = Sunday, default `1`), `activeForkMonths` (default `6`), `loc` (default `true`: a weekly shallow clone of each repo, about 10 to 15 Actions minutes for 120 repos; `false` skips it), `packages` (repo `name` or `owner/name` → list such as `["npm:@scope/pkg", "crates:name", "pypi:name", "dockerhub:ns/repo"]`, counted without the link-back check), `ignorePackages` (ids to leave out). See [Metrics](#metrics) |
