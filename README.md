# portfolio-radar-template

A daily, read-only report on every active repo across your GitHub account, your orgs and your client orgs: what needs you today, what changed, what's drifting, and patterns across repos. It feeds a mission-control dashboard with safe action buttons.

This repo is the **engine**. It holds no data. To use it, make your own **private** copy.

## Get started

The easy way is the Claude Code plugin, which walks you through every step, checks your machine, creates the read-only GitHub App in one click and runs the first report:

```
/plugin marketplace add agentic-incubator/portfolio-radar-plugin
/plugin install portfolio-radar@portfolio-radar
/radar-setup
```

By hand: click **Use this template → Create a new repository**, choose **Private**, then follow [docs/setup.md](docs/setup.md).

> Keep your copy private. The report lists your repo names, and client names if you add client orgs. Don't fork this repo: a fork of a public repo has to stay public.

## What you get

- `reports/latest.md`: the day's report, ranked. See [Reading the report](docs/reading-the-report.md).
- `data/latest.json` and `data/dashboard.json`: the same facts for tools and the dashboard.
- A daily GitHub Action that writes both and commits them to your copy.

## Docs

| Doc | What's in it |
|---|---|
| [Overview](docs/overview.md) | Why it exists and what it checks |
| [Setup](docs/setup.md) | Create the app, set secrets, install, first run |
| [How it works](docs/how-it-works.md) | Auth, data flow, config keys |
| [Reading the report](docs/reading-the-report.md) | Each section and what to do |
| [The dashboard](docs/dashboard.md) | The page and its buttons |
| [Updating](docs/updating.md) | Getting new engine versions into your copy |
| [Cleaning up branches](docs/cleanup.md) | Optional: remove merged branches on GitHub and in your clone |

## License

MIT. See [LICENSE](LICENSE).

Built with ❤️ by Chris Phillipson, Principal, CP Ventures Group, LLC
