# AGENTS.md: portfolio-radar

Rules for any agent working in a portfolio-radar repo (the public template or a private copy made from it).

- **Read-only toward other repos.** The radar's GitHub App gets read permissions only. Never add a write permission. The only write is the daily workflow committing `reports/` and `data/` to this repo.
- **No dependencies.** `scripts/radar.mjs` stays a single zero-dependency ES module using `fetch`, running on Node 24+.
- **Never commit secrets.** The App ID and private key live only in Actions secrets. `secrets/` is gitignored for local copies.
- **Report gaps, don't hide them.** Anything unreadable goes under "Couldn't check". Never show an unreadable value as zero.
- **Privacy.** A copy with real data must be a private repo. The public template holds no real owners, repo names or reports.
- **Engine vs your files.** Files listed under `engineFiles` in `engine.json` come from the template and are replaced by `/radar-update`. Put your own changes in `userFiles` (config, rules, README) so updates never overwrite them.
- **Tests.** Run `node --check scripts/radar.mjs && node --test test/*.test.mjs` before pushing. New analysis rules get a test.
- **Docs are part of done.** If behaviour, config keys, permissions or setup change, update `docs/` in the same PR.
- **Commits.** Conventional Commits; stage explicit paths only. No AI co-author trailer.
- **Merging.** Open the PR, get CI green, and stop. A person merges.
