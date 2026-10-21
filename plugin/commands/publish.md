---
description: Build and deploy the newest version tag on this machine, if nobody else is already doing it.
argument-hint: "[tag] [--retry] [--list]"
---

Publish with kanbai's git-based pipeline. The CLI is at `bin/kanbai.mjs` in this plugin's folder (`${CLAUDE_PLUGIN_ROOT}/bin/kanbai.mjs`); run it from inside the repo.

1. If the user passed `--list`, run `node <cli> publish --list` and show the result as a short table: tag, state, who, where, when. Stop there.
2. Otherwise run `node <cli> publish $ARGUMENTS` and let it finish. It picks the newest version tag, claims it on the `kanbai/publish` branch, runs the repo's `publish.command` from `.board.json` in a clean checkout, and records done or failed.
3. Report the outcome in one or two sentences:
   - **Published**: say which tag and how long it took.
   - **Busy**: someone else is building that tag; say who and where. Don't retry, and don't pick another tag on your own.
   - **Failed**: show the last lines of the output and suggest a fix. Only re-run with `--retry` when the user asks.
   - **Nothing to do**: say why. When the newest tag is already published, ask which version to deploy (redeploy or rollback: `/publish <tag>`), or offer to create a new tag with the kanbai MCP's `tag_release` (this container can't push tags itself). When secrets are missing, name them and say where they can go: this machine's environment, the Claude Code container's environment secrets, or the untracked `.env.publish` file. Never ask the user to paste secrets into the chat, and never write secret values into `.board.json`.
4. If `.board.json` has no `publish` section, explain that it needs `{ "publish": { "command": "…" } }` with the repo's build-and-deploy command, and offer to add it.

Never run the deploy command yourself outside `kanbai publish`: the claim is what keeps two machines from deploying at once.
