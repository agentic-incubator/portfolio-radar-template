# Why and what

## Why it exists

Work is often spread over dozens of active repos across several GitHub owners: your own account, orgs you run, and client orgs. Only some of them are cloned on your laptop. Without help, problems hide: a leaked secret in a repo you haven't opened in months, CI that has been red on `main` for a week, a pile of bot PRs, or the same vulnerable package in six repos.

The radar answers one question each morning: **what across all of GitHub needs me today?** It also tracks the repos tied to your current goals, so you can see if they're moving.

Its output is plain files, so other tools and agents can read it: `reports/latest.md` for people, `data/latest.json` and `data/dashboard.json` for code.

## Design choices

- **GitHub is the source of record.** It lists repos from GitHub, not from a local folder.
- **Read-only.** The GitHub App only has read permissions on the repos it checks. The workflow's own `contents: write` covers this repo only, for committing the report.
- **No dependencies.** One Node script using `fetch`. Nothing to install, nothing to keep patched.
- **Honest about gaps.** If something can't be read (the app isn't installed on an owner, scanning is off, a permission is missing), the report says so under "Couldn't check" instead of showing a misleading zero.
- **History in git.** Every day's report and snapshot is committed, so `git log reports/` is the history, and the next run compares against the last snapshot to spot what's new.

## What's in the repo

| Path | What it is |
|---|---|
| `scripts/radar.mjs` | The whole radar: list repos, collect, analyse, render, write |
| `radar.config.json` | Owners, client owners, thresholds, goal repos, repos to ignore |
| `scripts/add-owner.sh` | Onboard owners: add them to the config and print the app's install link |
| `scripts/installs.mjs` | Show where the app is installed versus the config |
| `.github/workflows/daily-radar.yml` | The daily run: build the report and commit it |
| `.github/workflows/ci.yml` | Syntax check and unit tests on every PR |
| `test/radar.test.mjs` | Unit tests for the analysis and rendering (no network) |
| `reports/` | `latest.md` and `YYYY-MM-DD.md`, written by the Action |
| `data/` | `latest.json` and `YYYY-MM-DD.json`, the raw snapshot; `dashboard.json`, the view the dashboard artifact reads |
| `docs/` | These docs |

## What the report covers

For each repo: open PRs (human and bot), open issues, the latest CI run of each workflow on the default branch, Dependabot alerts, code-scanning alerts, secret-scanning alerts, the latest release, last push, whether it has an `AGENTS.md`, and which dependency updater it uses (Renovate, Dependabot, both or neither). For each org: open GitHub Projects and their item counts by status.

It ranks all of that into five sections: needs you today, changed in the last 24 hours, drift, patterns across repos, and progress toward goals. A sixth section, noise, holds archived repos and forks that still raise alerts or bot PRs, with ways to silence, remove or fix each. See [Reading the report](reading-the-report.md).

## What it doesn't do

- It doesn't change, comment on, or merge anything in the repos it reads.
- It doesn't look at local clones, branches or worktrees. That would be a separate local scan.
- It doesn't send notifications. The report lands in this repo; the dashboard and anything else you point at it pick it up.
