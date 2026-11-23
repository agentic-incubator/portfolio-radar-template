# The dashboard

A mission-control page that redraws this radar's findings every morning and puts a button on each one. It reads `data/dashboard.json`, which the daily Action writes. The portfolio-radar plugin publishes and refreshes it (`/radar-dashboard`).

## What's on it

- **The scope.** Every active repo is a dot, grouped by owner. The closer to the centre, the sooner it needs you. Colour is the worst signal: magenta for an exposed secret, orange for critical or high alerts, amber for red CI, cyan for people's PRs, violet for piled-up bot PRs, grey for quiet repos. Dots that got worse since yesterday pulse.
- **Vitals** with a sparkline each, from the 60 days of totals in `data/dashboard.json`.
- **Today's moves.** The scope, vitals and today's moves make up the **Overview**, which the page opens on.
- **A section menu** shows one section at a time, grouped by what you do next: **Act now** (Needs you, Ready to ship, In flight), **Clean up in bulk** (One fix many repos, Dependency bots, Noise), **Keep an eye on** (Goals, Clients, Metrics, Drift) and **Today's read** (Couldn't check). Each tab shows a count, and `#<section>` at the end of the address opens one directly, for example `#metrics`.
- **Weekly trends** sit on the Overview between the vitals and Today's moves: how many PRs and issues the estate handled each week (flow) and how the health numbers moved (alerts, red CI, waiting PRs, quiet repos, Renovate and AGENTS.md coverage), each with the last week's change and a 12-week sparkline. See [Weekly flow](how-it-works.md#weekly-flow).
- **Every table sorts.** Click a column header to sort by it; click again to flip the order. Unknown values sort last either way, and each table remembers your choice. This covers Ready to ship, Dependency bots, Metrics and In flight.
- **In flight** is a fixed-height table showing about 10 rows at a time; the rest scroll.
- **Filters** by owner, and Clients for repos in `clientOwners` orgs. Filters and search apply to every section, vitals included: a filtered vital counts only the repos in view and shows the all-owners figure beside it, without the sparkline (history is kept for all repos only).
- **Footer** with the credit line, the plugin version and the engine version (`engine` in `data/dashboard.json`). An engine older than 0.4.0 doesn't report one, and the footer says so.

## Three ways to run it

The plugin picks the one your account supports.

| Tier | Needs | What you get |
|---|---|---|
| Full | claude.ai artifacts, scheduled tasks, and the Claude GitHub app on your owners | Live page, morning refresh, every button |
| Artifact only | claude.ai artifacts | Live page. Write buttons queue a request; `/radar-actions` in Claude Code runs the queue |
| HTML file | Nothing extra | A local `dashboard.html`. Write buttons copy a prompt to paste into Claude Code |

## Buttons

| Kind | Buttons | What runs |
|---|---|---|
| Go there | Alerts, Actions, PRs, Renovate dashboard, Review PR | A link to GitHub |
| Ask Claude | Ask Claude, in any repo's panel | Claude answers from that repo's facts. Read-only |
| Hand off | Fold bot PRs, Fix CI, Add AGENTS.md, Sweep one package across repos, Write a triage plan, and Move to Renovate (when turned on) | Claude opens a PR and stops. It never merges |
| Sweep all | Above "One fix, many repos" | First lists every repo and the packages it would clear for you to confirm. Then Claude works repo by repo: one PR per repo for all of its listed packages, after checking the alerts are still open and no open PR already covers them. In flight shows each repo's result: PR opened, PR already open, already fixed, skipped and why, or failed. It never merges. Steward-managed repos are left out |
| Approve a plan | On a finished triage plan: Approve, Approve, I OK it, Skip, Done | Each approved step becomes its own hand-off |
| Ship it | On a person's PR whose CI was green this morning | Squash-merge and delete the branch, only if the head is unchanged and every check is still green. Only the dashboard's owner can press it |
| Ship all | Top right of the Ready to ship table, when any PR in view was green this morning | First lists every green PR in view for you to confirm. Then Ship it runs on each one in turn, with the same checks just before each merge; a PR that changed, isn't green or can't merge is skipped. In flight shows each PR's result: merged, skipped and why, or failed. Only the dashboard's owner can press it |

## The rules every hand-off follows

From `handoff-rules.md` in your copy, or from workstation-steward if you use it:

- Only releases at least 3 days old, except the first patched release for a known advisory.
- Major and 0.x minor bumps are held back and listed, unless you approve that package on a plan step marked "Needs your OK".
- Work in a fresh clone, open a PR, and stop.

## Two GitHub apps, two jobs

| App | Can do | Used by |
|---|---|---|
| Your radar app | Read only | The daily report, and so the dashboard's data |
| Claude (Anthropic's, <https://github.com/apps/claude>) | Read and write | Hand-off and Ship it buttons |

Without the Claude app on an owner, the dashboard still shows that owner's repos, and Ask Claude still works. Buttons that open PRs or merge stop and say why.
