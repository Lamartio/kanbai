# kanbai

A kanban board and docs kept as markdown in your GitHub repo, maintained by Claude.

- **Online** (claude.ai, iPad, phone): a remote MCP server on Cloudflare that reads and commits to the repo for you.
- **Local** (Claude Code, parallel agents): a plugin with a CLI that edits the working copy, with issue numbers from the same server.
- **Publishing without a build server:** `/publish` builds and deploys a tagged version on whichever machine you're on, and git makes sure only one machine does.

Issue numbers are atomic: one number dispenser per repo hands them out, so two chats or two agents never get the same one.

## Guides

- **[Setup](./docs/setup.md):** deploy the server, connect Claude and Claude Code (also in devcontainers), add kanbai to a repo, set up publishing, troubleshooting.
- **[Usage](./docs/usage.md):** filing and refining issues, sub-issues, boards and lanes, searching, the doctor, releasing and publishing, plus a full reference of tools, CLI commands, `.board.json` and the issue format.

## At a glance

```
.board.json                          settings: folders, lanes, publishing
docs/board/
├── 000_board.md                     main board (generated, readable on GitHub)
├── 001_build-login.md               issue 001
├── 001_build-login/002_api.md       sub-issue 002
├── ANT-TEST_000_board.md            board ANT-TEST (generated)
├── ANT-TEST_001_create-home.md      issue ANT-TEST_001
└── ANT-TEST/002_about.md            also board ANT-TEST: folders and prefixes merge
```

- Lanes: **TODO → DOING → DONE → ARCHIVED** by default, configurable per repo.
- Leaving the first lane needs *Done when*; moving back needs a reason; deleting is archiving.
- Each issue has a *Why*, *Done when*, *Context*, *Constraints / not doing*, *Decisions*, *Open questions* and *Log*.

In a chat with the connector on:

> *"Use kanbai with owner/name as default, set up the board, and file an issue: dark mode toggle, because people use the app at night."*

## Developing kanbai

| Package | What |
| --- | --- |
| `packages/core` | All rules: naming, numbering, moves, board files, search, context pack, doctor, publish states. |
| `packages/mcp-server` | The Cloudflare Worker: GitHub sign-in (OAuth 2.1 for Claude), tools, number dispenser, per-commit read cache. |
| `packages/cli` | The local CLI, built into `plugin/bin/kanbai.mjs`, including `publish`. |
| `plugin/` | The Claude Code plugin: CLI, skill, `/publish`, and the MCP connection. |

```sh
bun install
bun run test          # every package
bun run typecheck
bun run --filter @kanbai/cli build   # after changing core or cli: rebuilds plugin/bin/kanbai.mjs
```

The server's tests run against a fake GitHub; the CLI's publish tests run against real local git repos. To run the server locally:

```sh
cd packages/mcp-server
cp .dev.vars.example .dev.vars     # a GitHub OAuth app with callback http://localhost:8787/callback
echo 'PUBLIC_URL=http://localhost:8787' >> .dev.vars
npx wrangler dev
```
