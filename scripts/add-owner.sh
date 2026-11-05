#!/usr/bin/env bash
# Onboard one or more GitHub owners (accounts or orgs) to the radar.
#
#   scripts/add-owner.sh my-org,other-org           # your own orgs
#   scripts/add-owner.sh --client acme-corp                 # a client org (marked as client work)
#   OWNERS="org-a org-b" scripts/add-owner.sh               # list from the environment
#
# Options:  --client          add to clientOwners instead of owners
#           --app <slug>      the GitHub App's URL name (default: $RADAR_APP_SLUG or portfolio-radar)
#           --open            open each install page in your browser (macOS `open` / Linux `xdg-open`)
#
# What it does, per owner: adds it to radar.config.json (if missing) and prints the app's install link,
# plus the Claude app's link (needed only for the dashboard's buttons to open PRs there).
# The secrets don't change: one App ID and key cover every owner. After installing, run
# scripts/installs.mjs to confirm, then commit radar.config.json.
set -eo pipefail   # no -u: macOS ships bash 3.2, where empty arrays trip it
cd "$(dirname "$0")/.."

list="client=false"; slug="${RADAR_APP_SLUG:-portfolio-radar}"; open_it=false; owners=()
while (($#)); do
  case "$1" in
    --client) list="client=true" ;;
    --app) slug="$2"; shift ;;
    --open) open_it=true ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) IFS=', ' read -r -a more <<<"$1"; owners+=("${more[@]}") ;;
  esac
  shift
done
if ((${#owners[@]} == 0)) && [[ -n "${OWNERS:-}" ]]; then IFS=', ' read -r -a owners <<<"$OWNERS"; fi
((${#owners[@]})) || { echo "Usage: scripts/add-owner.sh [--client] [--app slug] [--open] owner[,owner...]" >&2; exit 1; }

for o in "${owners[@]}"; do
  [[ -z "$o" ]] && continue
  node -e '
    const fs = require("fs"); const [o, client] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync("radar.config.json", "utf8"));
    const key = client === "client=true" ? "clientOwners" : "owners";
    const all = [...(cfg.owners ?? []), ...(cfg.clientOwners ?? [])].map((x) => x.toLowerCase());
    if (all.includes(o.toLowerCase())) { console.log(`${o}: already in radar.config.json`); process.exit(0); }
    (cfg[key] ??= []).push(o);
    fs.writeFileSync("radar.config.json", JSON.stringify(cfg, null, 2) + "\n");
    console.log(`${o}: added to ${key}`);
  ' "$o" "$list"
  url="https://github.com/apps/${slug}/installations/new"
  echo "   install: ${url}  (pick ${o}, choose All repositories)"
  echo "   buttons: https://github.com/apps/claude/installations/select_target  (Claude app, so dashboard buttons can open PRs in ${o})"
  if $open_it; then (command -v open >/dev/null && open "$url") || (command -v xdg-open >/dev/null && xdg-open "$url") || true; fi
done

cat <<NEXT

Next:
  1. Install the app on each owner above (a client's org owner has to do it; see docs/setup.md for a note to send).
  2. Confirm:  RADAR_APP_ID=<id> RADAR_APP_PRIVATE_KEY_FILE=secrets/key.pem node scripts/installs.mjs
  3. Commit radar.config.json on a branch and open a PR.
  4. For dashboard buttons on these owners, also install the Claude app (the "buttons" link). See docs/dashboard.md.
NEXT
