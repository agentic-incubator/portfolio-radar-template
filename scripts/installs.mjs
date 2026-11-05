#!/usr/bin/env node
// Lists where the GitHub App is installed and compares that with radar.config.json.
//   RADAR_APP_ID=<id> RADAR_APP_PRIVATE_KEY_FILE=secrets/key.pem node scripts/installs.mjs
// Prints owner names and repo-selection only. Never prints the key or any token.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appJwt } from "./radar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "radar.config.json"), "utf8"));
const id = process.env.RADAR_APP_ID;
const keyFile = process.env.RADAR_APP_PRIVATE_KEY_FILE;
const key = process.env.RADAR_APP_PRIVATE_KEY ?? (keyFile && readFileSync(keyFile, "utf8"));
if (!id || !key) {
  console.error("Set RADAR_APP_ID and RADAR_APP_PRIVATE_KEY_FILE (or RADAR_APP_PRIVATE_KEY).");
  process.exit(1);
}
const res = await fetch("https://api.github.com/app/installations?per_page=100", {
  headers: { Authorization: `Bearer ${appJwt(id, key)}`, Accept: "application/vnd.github+json", "User-Agent": "portfolio-radar" },
});
if (!res.ok) { console.error(`GitHub refused the app sign-in (${res.status}). Check the App ID and key.`); process.exit(1); }
const installs = await res.json();
const byLogin = new Map(installs.map((i) => [i.account.login.toLowerCase(), i]));
const configured = [...(cfg.owners ?? []).map((o) => [o, "owner"]), ...(cfg.clientOwners ?? []).map((o) => [o, "client"])];
let missing = 0;
for (const [o, kind] of configured) {
  const i = byLogin.get(o.toLowerCase());
  if (!i) missing++;
  console.log(`${i ? (i.suspended_at ? "SUSPENDED" : "ok       ") : "MISSING  "} ${o} (${kind})${i ? `, ${i.repository_selection} repositories` : ": install the app here"}`);
}
for (const i of installs) {
  if (!configured.some(([o]) => o.toLowerCase() === i.account.login.toLowerCase())) console.log(`extra     ${i.account.login}: installed but not in radar.config.json (run scripts/add-owner.sh ${i.account.login})`);
}
process.exit(missing ? 2 : 0);
