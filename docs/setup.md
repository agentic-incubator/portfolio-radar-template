# Setup

About 15 minutes, done once. The easiest way is the portfolio-radar plugin's `/radar-setup` wizard, which does every step below for you, including creating the app in one click. To do it by hand you need the `gh` CLI signed in as the owner of this repo. The app used here is named **portfolio-radar** (<https://github.com/apps/portfolio-radar>); if you set up your own copy, substitute your app's name wherever it appears.

## 1. Create the GitHub App

On github.com: **Settings → Developer settings → GitHub Apps → New GitHub App** (or go straight to <https://github.com/settings/apps/new>).

| Field | Value |
|---|---|
| GitHub App name | `portfolio-radar`. Names are unique across GitHub, so pick another if it's taken. The name becomes the app's URL (`github.com/apps/<name>`) |
| Description | "Read-only daily status report across my repos. Reads PRs, issues, CI and security alerts; never writes." Installers see this |
| Homepage URL | `https://github.com/<you>/portfolio-radar` (your private copy) |
| Redirect URI, Setup URL | Leave empty. The app never signs users in |
| Expire user authorization tokens | Leave as it is (ticked by default). It only affects user sign-in, which this app doesn't use |
| Request user authorization during installation, Enable Device Flow, Redirect on update | Leave unticked |
| Webhook → Active | **Untick.** The radar polls, it doesn't need events. The Webhook URL field then disappears |
| Subscribe to events | Leave all unticked |

**Repository permissions:** set these to **Read-only** and leave everything else at "No access".

| Permission | Used for |
|---|---|
| Actions | CI runs on the default branch |
| Code scanning alerts | Code-scanning alerts |
| Contents | Latest release, `AGENTS.md` check |
| Dependabot alerts | Dependabot alerts |
| Issues | Open issues |
| Metadata | Mandatory; repo list, visibility, push date |
| Pull requests | Open PRs |
| Secret scanning alerts | Exposed secrets |

**Organization permissions:**

| Permission | Used for |
|---|---|
| Projects: Read-only | Org GitHub Projects |

**Account permissions:** none.

**Where can this GitHub App be installed?** Choose **Any account**. "Only on this account" would stop you installing it on your orgs or a client's org. Choosing "Any account" doesn't give anyone access to anything: the app can only read what each installer grants it, and only someone holding the private key can act as it.

Click **Create GitHub App**.

## 2. Save the App ID and a private key

On the app's settings page:

1. Copy the **App ID**: the number near the top. Not the **Client ID** (it starts with `Iv`), which is for user sign-in.
2. Under **Private keys**, click **Generate a private key**. A `.pem` file downloads.

Add both as Actions secrets on this repo. This is done **once**: the same two secrets cover every owner, now and later.

```bash
gh secret set RADAR_APP_ID --repo <you>/portfolio-radar --body "<App ID>"
gh secret set RADAR_APP_PRIVATE_KEY --repo <you>/portfolio-radar < path/to/key.pem
gh secret list --repo <you>/portfolio-radar   # names only, never values
```

If you keep local copies, put them in `secrets/` in your clone (it's in `.gitignore`), for example `secrets/id.yml` holding `id: <App ID>` and `secrets/key.pem`. Then:

```bash
git check-ignore -q secrets/key.pem && echo "ignored"   # confirm before anything else
gh secret set RADAR_APP_ID --repo <you>/portfolio-radar --body "$(yq '.id' secrets/id.yml)"
gh secret set RADAR_APP_PRIVATE_KEY --repo <you>/portfolio-radar < secrets/key.pem
```

`yq '.id'` is the Homebrew (mikefarah) yq; the Python yq needs `yq -r '.id'`. If yq reports "found character that cannot start any token", the file has a tab: YAML only allows spaces.

Keep a copy of the `.pem` in your password manager too. GitHub can't show it again; if it's lost, generate a new one (see "Rotating the private key").

## 3. Install the app on each owner

From the app's settings page, click **Install App**, or open <https://github.com/apps/portfolio-radar/installations/new>.

**Your account and your orgs** (the ones in `owners`): pick the account, choose **All repositories** so new repos are picked up automatically, and click **Install**. You must be an owner of an org to install there. If you're only a member, GitHub sends the owner a request to approve.

**A client org:** you can't install it yourself unless you're an org owner. Send the org owner this:

> I use a small read-only GitHub App to put all my repos into one daily status report. Could you install it on the org? Link: https://github.com/apps/portfolio-radar/installations/new. It only asks for read access to metadata, contents, issues, pull requests, Actions, and security alerts, plus read access to org Projects. You can limit it to the repos I work on, and remove it at any time under Settings → GitHub Apps.

Until they install it, the report lists that org under "Couldn't check". Nothing else breaks.

## 4. First run

GitHub only runs a workflow on demand once the workflow file is on the default branch, so the first run happens after this repo's setup PR is merged to `main`.

```bash
gh workflow run "Daily portfolio radar" --repo <you>/portfolio-radar
gh run watch --repo <you>/portfolio-radar
```

Before that, you can check the installs from your clone: `RADAR_APP_ID=<App ID> RADAR_APP_PRIVATE_KEY_FILE=secrets/key.pem node scripts/installs.mjs`.

Then open `reports/latest.md`. Check the "Couldn't check" section: each owner the app isn't installed on is listed there. After this, it runs daily on its own.

## Adding an owner later

No secrets and no workflow changes: the radar finds every installation of the app at run time.

```bash
scripts/add-owner.sh new-org,other-org          # your orgs; comma- or space-separated
scripts/add-owner.sh --client client-org        # a client org, marked as client work
scripts/add-owner.sh --open new-org             # also open the install page in your browser
```

For each owner it adds the name to `radar.config.json` (if it isn't there) and prints the install link. Then:

1. Install the app on each owner (step 3). For a client org, send their org owner the note above.
2. Check where the app is installed versus the config:

   ```bash
   RADAR_APP_ID=<App ID> RADAR_APP_PRIVATE_KEY_FILE=secrets/key.pem node scripts/installs.mjs
   ```

   Each configured owner shows `ok`, `MISSING` (not installed yet) or `SUSPENDED`. Installs not in the config show as `extra`. It prints names only, never the key or a token.
3. Commit `radar.config.json` on a branch and open a PR.
4. If you want the dashboard's buttons to work on that owner's repos, also install the **Claude** app there (the script prints its link). The radar app only reads; the Claude app is what opens and merges PRs. See [the dashboard](dashboard.md#two-github-apps-two-jobs).

If you install the app somewhere but forget the config, the report says so under "Couldn't check" rather than silently skipping it. If your app's URL name isn't `portfolio-radar`, pass `--app <slug>` or set `RADAR_APP_SLUG`.

## Removing an owner

Remove it from `radar.config.json`, then uninstall the app from that owner (**Settings → Applications → Installed GitHub Apps** for your account; **Org settings → GitHub Apps** for an org).

## Changing permissions

If you add a permission to the app later, every install has to accept it: GitHub emails each owner, or they accept under **Installed GitHub Apps → Configure**. Until they do, the old permissions apply.

## Rotating the private key

Keys don't expire, but rotate one if it may have leaked:

1. Generate a new private key on the app's settings page.
2. `gh secret set RADAR_APP_PRIVATE_KEY --repo <you>/portfolio-radar < new.pem`
3. Run the workflow once to confirm, then delete the old key on the app's settings page.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| An owner is under "Couldn't check: the GitHub App isn't installed there" | Install it there (step 3). `scripts/installs.mjs` shows which owners are missing |
| The run fails with "GitHub App sign-in failed" | `RADAR_APP_ID` or `RADAR_APP_PRIVATE_KEY` is wrong. Re-set them (step 2) |
| "Couldn't list repos for X: GitHub refused the token" | The install is suspended, or the org blocks GitHub Apps. Check the org's GitHub Apps settings |
| A repo you expected is missing | Install set to "Only select repositories" (add it), or it's in `ignoreRepos`. Archived repos and forks are listed under section 6, Noise, not with the active repos |
| A dashboard button stops with "push refused" or "Claude doesn't have GitHub access" | The Claude app isn't installed on that owner. See [the dashboard](dashboard.md#two-github-apps-two-jobs) |
| Alerts show as not readable | Scanning is off in that repo, or the install hasn't accepted the alert permissions |
| The commit step fails | Branch protection on `main` blocks the Action's push. Allow `github-actions[bot]`, or turn protection off for this repo |
