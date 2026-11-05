# Reading the report

The headline line gives totals: active repos (how many private), open PRs, open issues, open security alerts, and repos with CI failing on their default branch.

## 1. Needs you today

Ranked, most urgent first, top 25 (the rest are in `data/latest.json`):

1. **Exposed secret.** Secret scanning found a credential. Rotate it first, then close the alert.
2. **Critical or high security alerts** (Dependabot or code scanning), with how many are new since yesterday.
3. **CI failing on the default branch.** The latest completed run of a workflow on `main` (or whatever the default is) failed.
4. **Human PRs waiting.** Open, non-draft PRs from people, oldest first.

## 2. Changed in the last 24 hours

New issues, new PRs (bot PRs are labelled) and new releases.

## 3. Drift

Not urgent, but it piles up:

- **No push in 90+ days.** Archive it, or note why it's parked.
- **Bot PRs piling up** (3 or more), split by Renovate, Dependabot and other bots, with a link to Renovate's Dependency Dashboard where there is one. Fold them into one dependency branch, or turn on Renovate grouping or automerge for that repo.
- **Dependency updates.** How many repos use Renovate, Dependabot, both, or neither. "Both" usually means duplicate PRs for the same bump: keep one, or keep Dependabot for security updates only and switch off its version updates. "Neither" lists repos that get no update PRs at all.
- **PRs quiet for 30+ days.** Close, finish or hand off.
- **Missing AGENTS.md.** Agents working in that repo have no rules to follow.

## 4. Patterns across repos

- The same vulnerable package with alerts in two or more repos, so one upgrade pass can clear them all.
- The same workflow name failing in two or more repos, which usually means a shared cause such as a reusable workflow, a runner image, or an expired secret.

## 5. Toward your goals

For each goal in `goalRepos`: open PRs, issues, CI state and last push for its repos.

## 6. Noise: archived and forked repos

Archived repos and forks that still raise something: security alerts, bot PRs, failing scheduled workflows, or a Dependabot config that keeps opening PRs. They're kept out of sections 1 to 5 so they don't bury real work, with one exception: an exposed secret goes to the top of section 1 wherever it is.

Each line suggests one way to deal with it, then lists the others:

| Repo | Suggested first | Why |
|---|---|---|
| Archived, with alerts | **Silence:** turn off Dependabot alerts | Nobody ships from it, so its alerts can't be acted on |
| Archived, no alerts | **Fix:** unarchive, close the stale bot PRs and remove `dependabot.yml`, archive again | An archived repo is read-only, so its old PRs can't be closed as it is |
| Any archived | Remove: delete it (mirror-clone first) | Gone for good, with all its noise |
| Fork with no commits of yours | **Remove:** delete the fork | Nothing of yours is lost |
| Fork with commits of yours | **Fix:** add it to `activeForks` | It's your work, so it gets the full report |
| Fork, unknown | **Silence:** turn off its alerts and Actions | Safe until you know whether it holds your work |
| Any fork | Sync with upstream | Usually clears the alerts it inherited |

An archived repo runs no workflows, so a red last run there isn't counted. The radar never acts on any of this itself. The [dashboard](dashboard.md) offers each option as a button.

## GitHub Projects

Open org Projects, with item counts by Status and when each was last updated.

## Couldn't check

Anything the radar couldn't read, and why. Typical entries:

- *Not checked: <owner>. The GitHub App isn't installed there yet.* Install it (see [Setup](setup.md)).
- *Some repos have code scanning off.* Expected for repos without CodeQL. Switch it on in the repo's Security settings if you want it.
- *GitHub Projects not read for <owner>.* The app needs Organization → Projects: read, or the org hasn't approved the updated permissions.
