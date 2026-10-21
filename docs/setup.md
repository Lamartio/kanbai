# Setting up kanbai

Four parts, in this order. You only do part 1 once; parts 2–4 per device or per repo.

1. [Deploy the MCP server](#1-deploy-the-mcp-server) to Cloudflare (once)
2. [Connect Claude](#2-connect-claude): claude.ai and the apps, and Claude Code
3. [Add kanbai to a repo](#3-add-kanbai-to-a-repo)
4. [Set up publishing](#4-set-up-publishing) (optional)

Then: [Updating kanbai](#updating-kanbai) and [Troubleshooting](#troubleshooting).

## Before you start

- A **Cloudflare** account (the free plan is enough).
- A **GitHub** account with the repos you want boards in.
- On the machine you deploy from: **Node.js 20+** and **bun** (or npm), and a clone of this repo:

  ```sh
  git clone https://github.com/Lamartio/kanbai && cd kanbai
  bun install
  ```

## 1. Deploy the MCP server

The server runs as a Cloudflare Worker. Its address will be `https://kanbai.<your-subdomain>.workers.dev`; your subdomain shows in the Cloudflare dashboard under *Workers & Pages*. Everything below runs from `packages/mcp-server`.

```sh
cd packages/mcp-server
npx wrangler login
```

### 1.1 Create a GitHub OAuth app

This is how you'll sign in, and how the server gets access to your repos.

1. Open [github.com/settings/developers](https://github.com/settings/developers) → *OAuth Apps* → *New OAuth App*.
2. Fill in:
   - **Application name:** `kanbai`
   - **Homepage URL:** `https://kanbai.<your-subdomain>.workers.dev`
   - **Authorization callback URL:** `https://kanbai.<your-subdomain>.workers.dev/callback`
3. Click *Register application*. Copy the **Client ID**, then click *Generate a new client secret* and copy the **secret**. You'll paste both in step 1.4.

### 1.2 Create the two storage namespaces

```sh
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create BOARD_KV
```

Each command prints an `id`. Paste them into `wrangler.jsonc`, replacing `REPLACE_WITH_OAUTH_KV_ID` and `REPLACE_WITH_BOARD_KV_ID`.

- `OAUTH_KV` holds sign-in sessions (encrypted).
- `BOARD_KV` holds the read cache and each user's default repo.

### 1.3 Set the public URL

In `wrangler.jsonc`, set `vars.PUBLIC_URL` to `https://kanbai.<your-subdomain>.workers.dev`, without a trailing slash. Sign-in fails if this doesn't match the real address.

### 1.4 Add the secrets and deploy

```sh
npx wrangler secret put GITHUB_CLIENT_ID       # paste the Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste the client secret
npx wrangler deploy
```

**Check it:** open `https://kanbai.<your-subdomain>.workers.dev` in a browser. You should see a short kanbai page with the connector URL.

> The GitHub login asks for the `repo` scope, so the server can reach every repo your GitHub account can. A GitHub App login, where you pick the repos, is planned.

## 2. Connect Claude

### claude.ai, desktop and mobile apps

1. In claude.ai: *Settings → Connectors → Add custom connector*.
2. **Name:** `kanbai`. **URL:** `https://kanbai.<your-subdomain>.workers.dev/mcp`. Leave the advanced OAuth fields empty: Claude registers itself.
3. Click *Connect*. You'll see kanbai's approval page, then GitHub's sign-in. Approve both.
4. The connector now works in every Claude app on your account, including the iPad and phone.

**Check it:** in a new chat, ask *"List my repos with kanbai."*

### Claude Code

Claude Code gets kanbai through the plugin, which also brings the local CLI, a skill and `/publish`.

1. If your server URL isn't `https://kanbai.lamartio.workers.dev`, change it in `plugin/.mcp.json` in your fork first.
2. In Claude Code, inside the repo you'll work on:

   ```text
   /plugin marketplace add Lamartio/kanbai
   /plugin install kanbai@kanbai
   ```

3. The first time a kanbai tool is used, Claude Code opens the sign-in in your browser. Approve, sign in with GitHub, done.

**In devcontainers and Claude Code containers**, install at project scope, so the repo remembers the plugin and every fresh container gets it:

```sh
claude plugin marketplace add Lamartio/kanbai --scope project
claude plugin install kanbai@kanbai --scope project
```

Commit the resulting `.claude/settings.json`. You can also put both lines in the devcontainer's `postCreateCommand`. After a container rebuild, sign in to the kanbai server once more (sign-ins are stored per user, in the container), unless your user's Claude folder is a mounted volume.

## 3. Add kanbai to a repo

Pick one of these; both do the same thing.

- **From chat:** *"Use kanbai with owner/name as default repo, and set up the board."* Claude calls `set_default_repo` and `init_board`, and commits.
- **Locally:** from the repo, run `node <plugin>/bin/kanbai.mjs init` (in Claude Code, just ask *"set up the kanbai board"*), then commit the new files.

This writes:

```text
.board.json              settings: folders, lanes, publishing
docs/board/000_board.md  the main board (generated)
```

Defaults: the board lives in `docs/board`, with lanes `TODO → DOING → DONE → ARCHIVED`. To change them, edit `.board.json` before the first issue, or later with `set_lanes` / `kanbai lanes` (see [Usage](./usage.md#lanes)). The docs folder can be a Docusaurus or VitePress site; kanbai only touches the board folder inside it.

Add this line to `.gitignore` now, even if you don't publish yet:

```text
.env.publish
```

## 4. Set up publishing

Optional: only for repos you want to build and deploy with `/publish` from your own machines.

1. **Write a deploy script** in the repo, for example `scripts/deploy.sh`, that installs, builds and deploys. Make it executable (`chmod +x`). It runs in a clean checkout of the tag and gets `KANBAI_TAG` and `KANBAI_COMMIT`.
2. **Add a `publish` section** to `.board.json`:

   ```json
   "publish": {
     "command": "./scripts/deploy.sh",
     "env": {
       "NODE_ENV": "production",
       "CLOUDFLARE_API_TOKEN": "${CLOUDFLARE_API_TOKEN}"
     }
   }
   ```

   `${NAME}` is a placeholder filled in on the machine that builds. Never write a real secret value here: the file is committed.
3. **Put the secrets on each machine that may publish:**
   - **Your computer:** a `.env.publish` file in the repo root (it's in `.gitignore` from step 3):

     ```text
     CLOUDFLARE_API_TOKEN=your-token
     ```

   - **A Claude Code container:** add them as the environment's secrets in its settings.

   A machine without them refuses to publish before claiming anything, so it never blocks others.
4. **Check it** without deploying: `/publish --dry-run` (or `kanbai publish --dry-run`).

How to release and publish day to day is in [Usage](./usage.md#publishing).

## Updating kanbai

- **Plugin:** `claude plugin update kanbai@kanbai` (add `--scope project` if installed that way).
- **Server:** pull this repo, then `cd packages/mcp-server && npx wrangler deploy`. Sessions and numbers survive redeploys.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Connecting in claude.ai fails right away | Check `PUBLIC_URL` in `wrangler.jsonc` matches the Worker's address exactly, then redeploy. |
| GitHub says the redirect URI isn't valid | The OAuth app's callback URL must be `<PUBLIC_URL>/callback`. |
| "Repo … not found, or not accessible" | Your GitHub account can't reach that repo, or the name is mistyped. `list_repos` shows what's reachable. |
| "No repo given and no default repo set" | Say which repo, or set one: *"use owner/name as default repo"*. |
| A tool says "Done when is empty" | Moving past the first lane needs *Done when*. Answer Claude's question, or `update` the issue first. |
| `kanbai create` asks for `--number` | Numbers come from the server's `reserve_numbers` (Claude does this for you). Offline only: `--offline`, then run the doctor after pushing. |
| `/publish` says a variable "is not set" | Add it to `.env.publish` on that machine, or to the container's environment secrets. |
| `/publish` says `.env.publish` is tracked by git | Run `git rm --cached .env.publish`, add it to `.gitignore`, commit, and replace the secrets in it: they're in the history. |
| `/publish` says someone is building | Another machine claimed that version. Wait, check with `/publish --list`, or after a crash, take over once the lease runs out (30 minutes by default). |
| The board file looks wrong | Run the doctor: `doctor` in chat, or `kanbai doctor --fix` locally. |
