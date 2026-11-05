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
   | Latest release | `/repos/{r}/releases/latest` | Contents |
   | AGENTS.md present | `/repos/{r}/contents/AGENTS.md` | Contents |
   | Renovate / Dependabot config | `/repos/{r}/contents` and `/contents/.github` (file names only) | Contents |
   | Repo list, push date | `/installation/repositories` | Metadata |
   | CI on open PRs | `/repos/{r}/actions/runs?head_sha=…` for each non-draft human PR (up to `maxPrsListed`) | Actions |
   | Fork's parent, commits ahead/behind | `/repos/{r}` and `/repos/{r}/compare/{parent}:{branch}...{owner}:{branch}` (forks only) | Metadata, Contents |
   | GitHub Projects (org) | GraphQL `organization.projectsV2` | Organization → Projects |

   A PR's CI state comes from the latest Actions run of each workflow on its head commit: green (all passed or skipped), red, pending, or none. Checks from other apps aren't read, because that would need the Checks permission; the dashboard's Ship it action checks the full status again before merging.
   A 403/404 on one check (for example, code scanning switched off) marks that check unreadable rather than failing the run.
   Which dependency updater a repo uses comes from three signals: a Renovate config file (`renovate.json`, `renovate.json5`, `.renovaterc`, `.renovaterc.json`, `.renovaterc.json5` at the root, or `renovate.json(5)` in `.github/`), a `.github/dependabot.yml`, and who opened the open PRs (`renovate[bot]`, a self-hosted `renovate-*` user, or `dependabot[bot]`). Renovate's "Dependency Dashboard" issue also counts, which catches Renovate configured inside `package.json`. Dependabot *alerts* are GitHub's vulnerability alerts and are read for every repo whichever updater it uses.
4. **Analyse.** It ranks findings (see [Reading the report](reading-the-report.md)) and compares today's alerts with `data/latest.json` from the last run, so newly opened alerts are called out.
5. **Write.** `reports/YYYY-MM-DD.md`, `reports/latest.md`, `data/YYYY-MM-DD.json`, `data/latest.json` (active repos under `repos`, archived and forked ones under `noise`), and `data/dashboard.json`, the compact view the dashboard artifact reads. It keeps one totals row per day for the last 60 days, carried forward from the previous file.
6. **Commit.** The workflow commits `reports/` and `data/` as `portfolio-radar` with `chore(report): daily radar <date>`. This uses the workflow's own `GITHUB_TOKEN`, not the app.

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
