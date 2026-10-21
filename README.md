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
- Default lanes: `TODO → DOING → DONE → ARCHIVED`. Leaving the first lane needs *Done when*; moving back needs a reason. Deleting is archiving.
- `.board.json` sets the folders and lanes:

```json
{ "docs": "docs", "board": "docs/board", "lanes": ["TODO", "DOING", "DONE", "ARCHIVED"], "attachments": "lfs", "archive": "ARCHIVED" }
```

### Lanes per repo

Each repo has its own lanes in `.board.json`, and every board in that repo uses them. Change them from chat with `set_lanes`, or locally with `kanbai lanes`:

```sh
node plugin/bin/kanbai.mjs lanes BACKLOG DOING REVIEW DONE --rename TODO=BACKLOG
```

- The archive lane is always last, and added when you leave it out (`ARCHIVED`, or `archived` when all lanes are lowercase).
- Issues in a lane that is renamed follow `--rename`; issues in a dropped lane go to the first lane. Each gets a Log line.
- Editing `.board.json` by hand works too: the doctor then moves issues in unknown lanes to the first lane.
- An issue in a lane named `DOING` (any case) gets you as assignee when you move it there unassigned.

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
| `set_lanes` | Changes the repo's lanes and moves issues along. |
| `get_board` | A board with its lanes, and the other boards. |
| `create_issue`, `create_issues` | File one issue, or a batch (e.g. a feature with sub-issues) in one commit. |
| `reserve_numbers` | Numbers without files, for the local flow. |
| `read_issue`, `update_issue`, `add_comment` | Read and refine. The Log is append-only. |
| `move_issue`, `archive_issue` | Lane changes with their rules. |
| `search_issues`, `search_docs` | Find issues by filters, or anything in the docs. |
| `context_pack` | Everything needed to start on an issue, in one call. |
| `doctor` | Finds and fixes problems after hand edits: duplicates, unknown lanes, stale board files, a lagging number counter. |
| `tag_release` | Creates the next version tag (major, minor, patch) after a preview. |
| `publish_status` | Read-only view of the publish pipeline per tag (see below). |

Every write is one commit on the default branch. If someone pushed in between, the server reads again and retries.

## Publishing from any client, without a build server

Build and deploy on your own machine or in a Claude Code container. Git decides who builds a tag, so two clients never deploy the same release.

```json
{ "publish": { "command": "npm ci && npm run deploy", "tags": "v*", "leaseMinutes": 30, "branch": "kanbai/publish" } }
```

```sh
node plugin/bin/kanbai.mjs publish          # or /publish in Claude Code
node plugin/bin/kanbai.mjs publish --list   # pending, building, done, failed per tag
```

Create the tag with `git tag v1.4.0 && git push --tags` on your computer, or from chat with the MCP's `tag_release` (bump major, minor or patch). Claude Code's cloud containers can't push tags, so from the iPad use `tag_release`.

How it works:

1. Everything is recorded on one branch, `kanbai/publish`. Each commit on it is one event (a claim, a renewal, done, failed, a manual release), with an empty tree and a JSON message. `git log kanbai/publish` is the deploy history.
2. Every write is a normal **fast-forward push** of one new commit. When two clients write at the same moment, the remote accepts one and rejects the other: that is the lock. Nothing is force-pushed or deleted, so it also works through restrictive git proxies such as Claude Code's cloud containers.
3. `publish` takes the newest tag matching `publish.tags` that isn't done yet (older open tags are *superseded*), **claims** it, and runs `publish.command` in a **clean checkout** of the tag (a temporary git worktree) with `KANBAI_TAG` and `KANBAI_COMMIT` set. Your working copy, and agents working in it, aren't touched.
4. While it runs, it renews the claim. A claim that isn't renewed within `leaseMinutes` (a crashed container, a closed laptop) can be taken over by the next client.
5. It records *done* or *failed* (who, where, when, exit code, end of the log). A failed tag waits for `--retry` or a new tag. `publish <tag> --release` drops a claim by hand.

Deploy secrets stay on the client that builds: set them in your shell, or as environment secrets of the Claude Code container. The MCP's `publish_status` shows the pipeline from chat.

## Local flow: the Claude Code plugin

```text
/plugin marketplace add Lamartio/kanbai
/plugin install kanbai@kanbai
```

The plugin connects Claude Code to the MCP server (edit `plugin/.mcp.json` if your URL differs), adds the `kanbai` skill, and adds `/publish`. Claude then reserves numbers with `reserve_numbers` and edits files with the CLI, so parallel agents stay fast and never collide. You commit the board changes with the code.

The CLI works on its own too:

```sh
node plugin/bin/kanbai.mjs --help
```

After changing `packages/core` or `packages/cli`, rebuild it with `bun run --filter @kanbai/cli build`.
