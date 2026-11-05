# Updating your copy

Your private copy was made from `agentic-incubator/portfolio-radar-template`. New engine versions are released there as version tags (`v0.2.0`, …).

`engine.json` splits the files in two:

| List | Who owns it | On update |
|---|---|---|
| `engineFiles` | The template | Replaced with the new version |
| `userFiles` | You | Never touched. Keep your own notes in `docs/local/`, which is listed here |

## With the plugin

Run `/radar-update`. It compares your `engine.json` version with the newest tag, shows what changed, and opens a pull request in your copy that touches engine files only. It never merges: you review and merge it.

## By hand

```bash
git remote add template https://github.com/agentic-incubator/portfolio-radar-template.git
git fetch template --tags
git switch -c chore/engine-update
# for each path in engine.json's engineFiles:
git checkout <tag> -- scripts/radar.mjs   # and so on
node --check scripts/radar.mjs && node --test test/*.test.mjs
```

Then commit, push and open a PR. If you changed an engine file yourself, the update replaces it, so keep your changes in config or open a PR upstream instead.
