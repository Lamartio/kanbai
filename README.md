# kanbai

A kanban board and docs kept as markdown in your GitHub repo, maintained by Claude.

- **Online** (claude.ai, iPad, phone): a remote MCP server on Cloudflare that reads and commits to the repo for you.
- **Local** (Claude Code, parallel agents): a plugin with a CLI that edits the working copy, and gets issue numbers from the same server.

Issue numbers are atomic: one Durable Object per repo hands them out, so two chats or two agents never get the same one.

## How a board looks in a repo

```
.board.json
docs/board/
├── 000_board.md                     main board (generated)
├── 001_build-login.md               issue 001
├── 001_build-login/002_api.md       sub-issue 002 (same board, not listed on the board file)
├── ANT-TEST_000_board.md            board ANT-TEST (generated)
├── ANT-TEST_001_create-home.md      issue ANT-TEST_001
└── ANT-TEST/002_about.md            also board ANT-TEST: folders and prefixes merge
```

- Board names are kebab-case and case-sensitive. Numbers count per board.
- Issues have frontmatter (`title`, `type`, `status`, `assignee`, `created`, `tags`, `links`, `attachments`, `released`) and sections: *Why*, *Done when*, *Context*, *Constraints / not doing*, *Decisions*, *Open questions*, *Log*.
- Default lanes: `idea → ready → doing → review → done → archived`. Leaving the first lane needs *Done when*; moving back needs a reason. Deleting is archiving.
- `.board.json` sets the folders and lanes:

```json
{ "docs": "docs", "board": "docs/board", "lanes": ["idea", "ready", "doing", "review", "done", "archived"], "attachments": "lfs", "archive": "archived" }
```

## Packages

| Package | What |
| --- | --- |
| `packages/core` | All board rules: naming, numbering, moves, board files, search, context pack, doctor. Unit tests. |
| `packages/mcp-server` | The Cloudflare Worker: GitHub login (OAuth 2.1 for Claude), tools, number dispenser, per-commit read cache. Tests against a fake GitHub. |
| `packages/cli` | The local CLI, built into `plugin/bin/kanbai.mjs`. |
| `plugin/` | The Claude Code plugin: the CLI, a skill for the local flow, and the MCP connection. |

```sh
bun install
bun run test        # every package
bun run typecheck
```

## Deploy the MCP server

You need a Cloudflare account and a GitHub account. Everything below runs from `packages/mcp-server`.

1. **Create a GitHub OAuth app** at [github.com/settings/developers](https://github.com/settings/developers) → *OAuth Apps* → *New OAuth App*:
   - Homepage URL: `https://kanbai.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://kanbai.<your-subdomain>.workers.dev/callback`

   Keep the client ID, and generate a client secret.

2. **Create the two KV namespaces** and paste their ids into `wrangler.jsonc`:

   ```sh
   npx wrangler login
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler kv namespace create BOARD_KV
   ```

3. **Check `PUBLIC_URL`** in `wrangler.jsonc`. It must be the Worker's real URL (your workers.dev subdomain shows in the Cloudflare dashboard under *Workers & Pages*).

4. **Add the GitHub secrets and deploy:**

   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler deploy
   ```

5. **Connect Claude:** *Settings → Connectors → Add custom connector*, URL `https://kanbai.<your-subdomain>.workers.dev/mcp`. Claude registers itself; you approve, then sign in with GitHub.

6. **Try it** in a chat: "Use kanbai with repo owner/name as default, set up the board, and file an issue for …".

The GitHub login asks for the `repo` scope, so the server can reach every repo your account can. Moving to a GitHub App (pick repos at install) is planned.

### Run it locally

```sh
cp .dev.vars.example .dev.vars      # fill in a GitHub OAuth app with callback http://localhost:8787/callback
echo 'PUBLIC_URL=http://localhost:8787' >> .dev.vars
npx wrangler dev
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_repos`, `set_default_repo` | Pick the repo the other tools use. |
| `init_board` | Writes `.board.json` and the board files. |
| `get_board` | A board with its lanes, and the other boards. |
| `create_issue`, `create_issues` | File one issue, or a batch (e.g. a feature with sub-issues) in one commit. |
| `reserve_numbers` | Numbers without files, for the local flow. |
| `read_issue`, `update_issue`, `add_comment` | Read and refine. The Log is append-only. |
| `move_issue`, `archive_issue` | Lane changes with their rules. |
| `search_issues`, `search_docs` | Find issues by filters, or anything in the docs. |
| `context_pack` | Everything needed to start on an issue, in one call. |
| `doctor` | Finds and fixes problems after hand edits: duplicates, unknown lanes, stale board files, a lagging number counter. |

Every write is one commit on the default branch. If someone pushed in between, the server reads again and retries.

## Local flow: the Claude Code plugin

```text
/plugin marketplace add Lamartio/kanbai
/plugin install kanbai@kanbai
```

The plugin connects Claude Code to the MCP server (edit `plugin/.mcp.json` if your URL differs) and adds the `kanbai` skill. Claude then reserves numbers with `reserve_numbers` and edits files with the CLI, so parallel agents stay fast and never collide. You commit the board changes with the code.

The CLI works on its own too:

```sh
node plugin/bin/kanbai.mjs --help
```

After changing `packages/core` or `packages/cli`, rebuild it with `bun run --filter @kanbai/cli build`.
