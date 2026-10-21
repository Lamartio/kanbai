# Using kanbai

kanbai keeps a kanban board as markdown files in your repo. You mostly just talk to Claude: in a chat (claude.ai, iPad, phone) or in Claude Code. This guide shows what to say, what happens, and the rules behind it. Setup is in [setup.md](./setup.md).

- [Two ways to work](#two-ways-to-work)
- [Issues](#issues): file, refine, split, work, finish, archive
- [Boards](#boards) and [lanes](#lanes)
- [Finding things](#finding-things)
- [The doctor](#the-doctor)
- [Publishing](#publishing)
- [Reference](#reference): tools, CLI, `.board.json`, issue file

## Two ways to work

| | Online | Local |
| --- | --- | --- |
| Where | claude.ai, desktop and mobile apps | Claude Code, on your computer or in a container |
| How | Claude calls the kanbai server, which commits to GitHub for you | Claude edits files in your working copy with the kanbai CLI |
| Commits | One commit per change, on the default branch | You commit board changes together with the code |
| Numbers | From the server | Also from the server (`reserve_numbers`), so parallel agents never collide |
| Best for | Capturing ideas, refining, checking the board from anywhere | Building: many agents working fast in parallel |

Both follow the same rules, so you can mix them freely.

## Issues

An issue is one markdown file, named by its number and a short name: `013_dark-mode-toggle.md`. The number is its identity and never changes; the file is never deleted.

### File an idea

While ideating, say what you concluded:

> *"File this as an issue: a dark mode toggle, because people use the app at night."*

Only a **title** and a **why** are required. Claude fills in what the conversation already settled (context, decisions, constraints) and tells you what is still missing. Answer, or leave it for later: gaps go under *Open questions*.

New issues land in the first lane (TODO).

### Refine it

Before an issue can leave TODO, it needs **Done when**: what must be true when it's finished. For user-facing work, write 3–5 concrete behaviours as plain sentences:

> *"Done when for 013: toggling switches the theme without a reload; the choice survives a restart; it follows the system setting until the user picks one."*

For refactors and chores, a plain checklist is enough. Claude can draft these from the *Why* for you to approve.

### Split into sub-issues

> *"Split 013 into sub-issues: design the toggle, store the preference, add the setting screen."*

Sub-issues go in a folder named after the parent (`013_dark-mode-toggle/014_design-the-toggle.md`) and take numbers from the same board, reserved in one batch. They don't appear on the board file; the parent does.

### Start working

> *"Start on 013."*

Claude loads the **context pack**: the issue, its parent and sub-issues, linked issues, docs that mention it, and the files named in its *Context*. Then it moves the issue to DOING, which assigns it to you if nobody had it.

### Finish

> *"013 is done."*

Moving forward through the lanes is free once *Done when* is filled in. **Moving back** needs a reason, which goes in the issue's *Log*:

> *"Move 013 back to TODO: the design changed."*

### Comment

> *"Note on 013: the iOS version needs a separate switch."*

Comments are dated lines in the issue's *Log*. The Log is append-only.

### Archive instead of delete

> *"Archive 009, it's a duplicate of 013."*

The issue moves to ARCHIVED with the reason. The file and its number stay, so links and references keep working. Archived issues are hidden from searches unless you ask for them.

## Boards

One repo can hold several boards. The main board needs no name; another board gets a kebab-case name, like `ANT-TEST` (case matters: `ANT-TEST` and `ant-test` are different boards).

> *"File a TODO on the ANT-TEST board: create the home page."*

Its issues are named `ANT-TEST_001_create-home.md`, with their own numbering, and the board gets its own generated board file. If you prefer folders, put them in `ANT-TEST/001_create-home.md`: files with the prefix and files in the folder belong to the same board.

Ids in chat: `013` on the main board, `ANT-TEST_001` on another.

Every board has a generated board file (`000_board.md`, `ANT-TEST_000_board.md`) with a header per lane and a link per issue. It's readable on GitHub without any app. Never edit it by hand: kanbai rewrites it on every change.

## Lanes

Default: **TODO → DOING → DONE → ARCHIVED**. Each repo can have its own:

> *"Change the lanes to BACKLOG, DOING, REVIEW, DONE, and rename TODO to BACKLOG."*

Locally: `kanbai lanes BACKLOG DOING REVIEW DONE --rename TODO=BACKLOG`.

- Issues in a renamed lane follow the rename; issues in a dropped lane go to the first lane. Each gets a Log line.
- ARCHIVED is always last and is added when you leave it out.
- All boards in a repo share the same lanes.

## Finding things

> *"What's in DOING?"* · *"Show the ANT-TEST board."* · *"Find issues about login."* · *"What's assigned to me?"* · *"Search the docs for rate limits."*

Searches cover titles, tags and the full text. Filters: board, lane, type (feature, bug, idea, decision), tag, assignee, release.

## The doctor

Git is decentralized: someone may create or edit issue files by hand, on another machine, or offline. The doctor finds what got out of line and fixes it.

> *"Run the kanbai doctor."*

It reports first. Then:

- **Safe fixes** (*"fix the safe ones"*): regenerate board files, move issues out of lanes that don't exist, add missing titles, catch up the number counter.
- **Proposed fixes** (*"apply all"*): give a duplicate number a fresh one (the oldest issue keeps the number), create a missing `.board.json`.

Locally: `kanbai doctor`, `kanbai doctor --fix`.

## Publishing

Build and deploy on whichever machine is at hand: no build server. Setup is in [setup.md](./setup.md#4-set-up-publishing).

### Release a version

1. **Tag it.** In chat: *"Tag a minor release."* Claude shows the next version (say `v1.5.0`) and creates it after you confirm. On your computer, `git tag v1.5.0 && git push --tags` works too. (Claude Code's cloud containers can't push tags, so from the iPad, use chat.)
2. **Publish it.** In Claude Code: `/publish`. It builds the newest tag in a clean checkout, deploys it, and records the result.
3. **Check it.** In chat: *"What's the publish status?"* In Claude Code: `/publish --list`.

### Which version gets built

- **`/publish`** builds the newest tag, but only if nobody is building or has published it. If someone is building it, it refuses and says who. If it's already published, it asks you to name a version.
- **`/publish v1.4.0`** builds that version anyway: to redeploy, or to roll back to an older one. Only refused while someone is building it.
- **After a failure**, fix it and tag a new version, or run `/publish --retry`.

Two machines can never deploy at once: the first to claim the version wins, the other is told who's building. If a machine dies mid-build, its claim runs out after 30 minutes (by default) and another machine can take over.

Secrets the build script prints are masked as `***` in the output and in the recorded log.

### Other publish commands

| Command | What it does |
| --- | --- |
| `/publish --dry-run` | Shows which version would be built, without building |
| `/publish v1.4.0 --release` | Drops a claim by hand, after you killed a build |
| `git log kanbai/publish` | The full deploy history |

## Reference

### Tools (online, via the server)

| Tool | What it does |
| --- | --- |
| `list_repos`, `set_default_repo` | Pick the repo the other tools use |
| `init_board` | Write `.board.json` and the board files |
| `set_lanes` | Change the lanes and move issues along |
| `get_board` | Show a board, and list the other boards |
| `create_issue`, `create_issues` | File one issue, or a batch with sub-issues, in one commit |
| `read_issue`, `update_issue`, `add_comment` | Read and refine an issue |
| `move_issue`, `archive_issue` | Change lanes, with the rules |
| `search_issues`, `search_docs` | Find issues, or anything in the docs |
| `context_pack` | Everything needed to start on an issue |
| `reserve_numbers` | Hand out numbers for the local flow |
| `doctor` | Check and fix the board |
| `tag_release` | Create the next version tag, after a preview |
| `publish_status` | Show the publish state per version |

### CLI (local)

The plugin's CLI is `bin/kanbai.mjs`; run it with `node`. In Claude Code, you normally just ask, and Claude runs it.

```text
kanbai init                                   write .board.json and the board files
kanbai list [--board B] [--lane L] [--text T] [--archived]
kanbai show <id>                              print an issue
kanbai context <id>                           issue, parent, sub-issues, links, mentions
kanbai create --number N --title T --why W [--board B | --parent ID] [--type …] [--status L]
              [--done-when …] [--context …] [--tag T]… [--assignee LOGIN]
kanbai create --offline …                     next free number locally (may collide)
kanbai update <id> [--title …] [--why …] [--done-when …] [--context …] [--note …]
kanbai move <id> <lane> [--reason …] [--actor LOGIN]
kanbai archive <id> [--reason …]
kanbai comment <id> <text> [--actor LOGIN]
kanbai doctor [--fix | --fix-all]
kanbai board                                  regenerate the board files
kanbai lanes [<lane>… [--rename OLD=NEW]…]    show or change the lanes
kanbai publish [<tag>] [--retry] [--dry-run] [--list] [--release]
```

Options: `--root DIR` (default: the nearest folder with `.git` or `.board.json`), `--json` for machine-readable output. The CLI writes files; it never commits.

### `.board.json`

```json
{
  "docs": "docs",
  "board": "docs/board",
  "lanes": ["TODO", "DOING", "DONE", "ARCHIVED"],
  "archive": "ARCHIVED",
  "attachments": "lfs",
  "publish": {
    "command": "./scripts/deploy.sh",
    "env": { "NODE_ENV": "production", "CLOUDFLARE_API_TOKEN": "${CLOUDFLARE_API_TOKEN}" },
    "envFile": ".env.publish",
    "tags": "v*",
    "leaseMinutes": 30,
    "branch": "kanbai/publish"
  }
}
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `docs` | Docs folder | `docs` |
| `board` | Board folder | `<docs>/board` |
| `lanes` | Lanes in order; the first is where new issues land | `TODO, DOING, DONE, ARCHIVED` |
| `archive` | The lane that replaces deleting; always last | `ARCHIVED` |
| `attachments` | `lfs` or `r2` (attachments are planned) | `lfs` |
| `publish.command` | What builds and deploys, run in a clean checkout of the tag; gets `KANBAI_TAG`, `KANBAI_COMMIT` | required for publishing |
| `publish.env` | Variables for the command. `${NAME}` is filled in on the building machine. Never real secrets. | none |
| `publish.envFile` | Untracked `KEY=value` file with secrets on the client | `.env.publish` |
| `publish.tags` | Which tags are versions | `v*` |
| `publish.leaseMinutes` | How long a claim lasts without renewal | 30 |
| `publish.branch` | Branch that records claims and results | `kanbai/publish` |

### Issue file

```markdown
---
title: Add dark mode toggle
type: feature          # feature | bug | idea | decision
status: TODO           # a lane
assignee: lamartio     # GitHub username
created: 2026-10-21
tags: [ui]
links: { blocks: [15], relates: [9] }
attachments: []
---

## Why
## Done when
## Context
## Constraints / not doing
## Decisions
## Open questions
## Log
```

Any section can stay empty except *Why*. *Done when* is required past the first lane. The *Log* is written by kanbai: creation, moves, comments, fixes.
