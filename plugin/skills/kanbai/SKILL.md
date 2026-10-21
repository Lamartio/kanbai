---
name: kanbai
description: Create, refine, move and archive board issues in this repo's markdown kanban board (docs/board, NNN_slug.md files, 000_board.md). Use when the user asks to file an idea or issue, split work into sub-issues, move an issue, start work on an issue, check the board, or run the board doctor while working in a local working copy.
---

# kanbai, local flow

The board lives in the repo as markdown. In a working copy, edit it with the kanbai CLI that ships with this plugin, and get issue numbers from the kanbai MCP server. That keeps numbers unique across chats, machines and parallel agents.

The CLI is at `../../bin/kanbai.mjs`, relative to this skill's base directory. Run it with `node <that path> <command>` from anywhere inside the repo. `node <that path> --help` lists every command.

## Rules

1. **Never pick an issue number yourself.** Don't look at the highest file number and add one: a parallel agent may do the same. Call the kanbai MCP tool `reserve_numbers` (with `repo` = the GitHub `owner/name` of this working copy, from `git remote get-url origin`, and `board` when it isn't the main board), then pass the number with `--number`.
2. **Reserve in batches.** When you create several issues (a feature with sub-issues), reserve them all in one `reserve_numbers` call with `count`.
3. **Never delete an issue file.** Archive it: `archive <id> --reason "…"`. The number stays taken.
4. **Don't edit `000_board.md` or `BOARD_000_board.md` by hand.** The CLI regenerates them on every change.
5. **Commit board changes with the code they belong to**, and push. The CLI only writes files.
6. **Offline fallback:** only when the MCP can't be reached, use `create --offline`. Tell the user, and run the MCP `doctor` tool after pushing; it renumbers collisions with the dispenser.

## Ids, boards and files

- Main board: `001_build-login.md`, id `001`.
- Another board (kebab-case, case-sensitive): `ANT-TEST_001_create-home.md` or `ANT-TEST/001_create-home.md`, id `ANT-TEST_001`. Numbers count per board.
- Sub-issues live in the parent's folder: `ANT-TEST/001_create-home/002_design.md`. They take numbers from the same board and aren't listed on the board file.

## Common tasks

**File an idea from the conversation.** Only title and why are required. Fill in what the conversation already settled.

```sh
node <cli> create --number 13 --title "Dark mode toggle" --why "Night use on the iPad" --context "\`src/theme.ts\`"
```

The output lists what is still missing (Done when, Context). Ask the user, then `update`.

**Split a feature into sub-issues.** Reserve `count` numbers on the board, create the parent, then each child with `--parent <parent id>`.

**Refine before work starts.** Leaving the first lane needs *Done when*: 3–5 concrete behaviours as plain sentences for user-facing work, a checklist for refactors.

```sh
node <cli> update 013 --done-when "- [ ] Toggling dark mode switches the theme without a reload
- [ ] The choice survives a restart"
node <cli> move 013 DOING --actor <github login>
```

**Start work.** `context <id>` prints the issue, parent, sub-issues, linked issues, mentions and the files named in its Context. Read those files, then move it to the working lane (`DOING` by default) with `--actor <github login>`.

**Finish.** Move it on to `DONE` (or the repo's own lanes: `node <cli> lanes` lists them). Moving back needs `--reason`.

**Change the columns.** `lanes A B C --rename OLD=NEW` rewrites `.board.json` and moves issues along. Only do this when the user asks.

**Check the board.** `doctor` reports problems; `doctor --fix` applies the safe fixes (board files, unknown lanes, missing titles). Leave renumbering to the MCP doctor.
