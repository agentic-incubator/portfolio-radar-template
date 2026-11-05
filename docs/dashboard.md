# The dashboard

A mission-control page that redraws this radar's findings every morning and puts a button on each one. It reads `data/dashboard.json`, which the daily Action writes. The portfolio-radar plugin publishes and refreshes it (`/radar-dashboard`).

## What's on it

- **The scope.** Every active repo is a dot, grouped by owner. The closer to the centre, the sooner it needs you. Colour is the worst signal: magenta for an exposed secret, orange for critical or high alerts, amber for red CI, cyan for people's PRs, violet for piled-up bot PRs, grey for quiet repos. Dots that got worse since yesterday pulse.
- **Vitals** with a sparkline each, from the 60 days of totals in `data/dashboard.json`.
- **Today's moves**, then lanes: Needs you, Ready to ship, One fix many repos, Dependency bots, Goals, Clients, Noise, Drift, In flight, and Couldn't check.
- **Filters** by owner, and Clients for repos in `clientOwners` orgs.

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
| Approve a plan | On a finished triage plan: Approve, Approve, I OK it, Skip, Done | Each approved step becomes its own hand-off |
| Ship it | On a person's PR whose CI was green this morning | Squash-merge and delete the branch, only if the head is unchanged and every check is still green. Only the dashboard's owner can press it |

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
