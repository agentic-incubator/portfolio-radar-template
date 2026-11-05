# Cleaning up merged branches

Merged pull requests leave branches behind, on GitHub and in your clone. Cleaning them up is optional and comes as two separate choices. The plugin's `/radar-setup` asks about each one, and both default to no. Without the plugin, here's how to do each by hand.

## Remote: GitHub deletes a merged PR's branch

GitHub has a per-repo setting, **Automatically delete head branches**. When it's on, GitHub deletes a PR's branch as soon as the PR merges. It never touches unmerged branches, and you can restore a deleted branch from the PR page.

By hand: repo **Settings → General → Pull Requests → Automatically delete head branches**.

With `gh` (you need admin rights on each repo):

```bash
# one repo
gh api -X PATCH repos/<you>/portfolio-radar -F delete_branch_on_merge=true --silent

# every non-archived repo you own in an account or org (leave client orgs to the client)
gh repo list <owner> --no-archived --source --limit 1000 --json nameWithOwner -q '.[].nameWithOwner' |
  while read r; do gh api -X PATCH "repos/$r" -F delete_branch_on_merge=true --silent && echo "on: $r"; done
```

To delete one leftover branch: `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`. An HTTP 422 means it's already gone.

## Local: tidy your clone after a merge

After a merge, from your clone, and only if `git status` shows no unsaved work:

```bash
git fetch --prune origin
git checkout main && git pull --ff-only origin main
git worktree remove <path>     # only a clean worktree for the merged branch; no --force
git branch -d <merged-branch>  # no -D
```

After a squash merge, `git branch -d` usually refuses, because the branch's commits aren't in `main` under the same IDs. Check the branch only holds what the PR merged, then delete it yourself with `-D`.

## Fewer prompts in Claude Code (optional)

Claude Code asks before each of these commands. To allow the safe forms and block the forced ones, add these rules yourself. Claude doesn't write its own permissions.

**Cloud sessions** read `.claude/settings.json` from the repo they work in. Commit this to `main`:

```json
{
  "permissions": {
    "allow": ["Bash(git fetch --prune:*)", "Bash(git push origin --delete:*)"],
    "deny": [
      "Bash(git push origin --delete main)", "Bash(git push origin --delete master)",
      "Bash(git push origin --delete develop)", "Bash(git push --force:*)", "Bash(git push -f:*)"
    ]
  }
}
```

**Your own computer**: merge these into `~/.claude/settings.json` and keep what's already there:

```json
{
  "permissions": {
    "allow": ["Bash(git fetch --prune:*)", "Bash(git branch -d:*)", "Bash(git worktree remove:*)", "Bash(git worktree prune:*)"],
    "deny": [
      "Bash(git branch -D:*)", "Bash(git branch --delete --force:*)",
      "Bash(git worktree remove --force:*)", "Bash(git worktree remove -f:*)",
      "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(rm -rf:*)"
    ]
  }
}
```

A deny rule always wins over an allow rule. `.claude/` is one of your files in `engine.json`, so `/radar-update` never changes it.

Even with these rules, a cloud session often can't delete a GitHub branch or change repo settings. When it can't, it says so and gives you the command to run.
