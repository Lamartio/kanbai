---
description: Build and deploy the newest version tag on this machine, if nobody else is already doing it.
argument-hint: "[tag] [--retry] [--list]"
---

Publish with kanbai's git-based pipeline. The CLI is at `bin/kanbai.mjs` in this plugin's folder (`${CLAUDE_PLUGIN_ROOT}/bin/kanbai.mjs`); run it from inside the repo.

1. If the user passed `--list`, run `node <cli> publish --list` and show the result as a short table: tag, state, who, where, when. Stop there.
2. Otherwise run `node <cli> publish $ARGUMENTS` and let it finish. It picks the newest version tag, claims it through git, runs the repo's `publish.command` from `.board.json` in a clean checkout, and records done or failed.
3. Report the outcome in one or two sentences:
   - **Published**: say which tag and how long it took.
   - **Busy**: someone else is building it; say who and where. Don't retry.
   - **Failed**: show the last lines of the output and suggest a fix. Only re-run with `--retry` when the user asks.
   - **Nothing to do**: say why (already published, no tags, or a failed tag waiting for `--retry`).
4. If `.board.json` has no `publish` section, explain that it needs `{ "publish": { "command": "…" } }` with the repo's build-and-deploy command, and offer to add it.

Never run the deploy command yourself outside `kanbai publish`: the claim is what keeps two machines from deploying at once.
