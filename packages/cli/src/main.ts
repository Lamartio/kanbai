#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  CONFIG_PATH,
  type FileChange,
  ISSUE_TYPES,
  type IssueType,
  addComment,
  archiveIssue,
  changeLanes,
  boardChanges,
  contextPack,
  createIssue,
  findIssue,
  formatId,
  isBoardName,
  loadBoard,
  missingInfo,
  moveIssue,
  parseId,
  runDoctor,
  searchIssues,
  serializeConfig,
  serializeIssue,
  updateIssue,
} from '@kanbai/core';
import { applyChanges, findRoot, loadWorkspace } from './workspace.js';

const HELP = `kanbai: keep the markdown board in this working copy.

Numbers are atomic: get them from the kanbai MCP's reserve_numbers tool and pass --number.
Only use --offline when the MCP can't be reached; the doctor fixes collisions later.

  kanbai init                                  write .board.json and the board files
  kanbai list [--board B] [--lane L] [--text T] [--archived]
  kanbai show <id>                             print an issue
  kanbai context <id>                          issue, parent, sub-issues, links, mentions
  kanbai create --number N --title T --why W [--board B | --parent ID] [--type feature|bug|idea|decision]
                [--status L] [--done-when TEXT] [--context TEXT] [--tag T]... [--assignee LOGIN]
  kanbai create --offline ...                  take the next free number locally (may collide)
  kanbai update <id> [--title T] [--done-when TEXT] [--why TEXT] [--context TEXT] [--note TEXT]
  kanbai move <id> <lane> [--reason TEXT] [--actor LOGIN]
  kanbai archive <id> [--reason TEXT]
  kanbai comment <id> <text> [--actor LOGIN]
  kanbai doctor [--fix | --fix-all]            report; --fix applies safe fixes; --fix-all also renumbers (offline numbers)
  kanbai board                                 regenerate the board files
  kanbai lanes <lane>... [--rename OLD=NEW]...  change the columns; issues in dropped lanes move along

Options: --root DIR (default: nearest folder with .git or .board.json), --json
Ids: 012 on the main board, ANT-TEST_012 on board ANT-TEST. Changes are written, not committed.`;

const today = () => new Date().toISOString().slice(0, 10);

function fail(message: string): never {
  process.stderr.write(`kanbai: ${message}\n`);
  process.exit(1);
}

function requireRef(value: string | undefined) {
  if (!value) fail('missing issue id.');
  const ref = parseId(value);
  if (!ref) fail(`"${value}" isn't an issue id. Use 012 or BOARD_012.`);
  return ref;
}

const STRING_OPTIONS = new Set(['root', 'number', 'board', 'parent', 'title', 'why', 'type', 'status', 'done-when', 'context', 'constraints', 'decisions', 'open-questions', 'tag', 'assignee', 'lane', 'text', 'reason', 'actor', 'note', 'rename']);

/** `--done-when "- [ ] x"` would be read as an option; glue such values on with `=`. */
function glueValues(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : undefined;
    if (name && STRING_OPTIONS.has(name) && index + 1 < argv.length) result.push(`${arg}=${argv[++index]}`);
    else result.push(arg);
  }
  return result;
}

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: glueValues(argv),
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      number: { type: 'string' },
      offline: { type: 'boolean' },
      board: { type: 'string' },
      parent: { type: 'string' },
      title: { type: 'string' },
      why: { type: 'string' },
      type: { type: 'string' },
      status: { type: 'string' },
      'done-when': { type: 'string' },
      context: { type: 'string' },
      constraints: { type: 'string' },
      decisions: { type: 'string' },
      'open-questions': { type: 'string' },
      tag: { type: 'string', multiple: true },
      assignee: { type: 'string' },
      lane: { type: 'string' },
      text: { type: 'string' },
      archived: { type: 'boolean' },
      reason: { type: 'string' },
      actor: { type: 'string' },
      note: { type: 'string' },
      rename: { type: 'string', multiple: true },
      fix: { type: 'boolean' },
      'fix-all': { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const root = values.root ?? findRoot(process.cwd());
  const workspace = loadWorkspace(root);
  const { config, snapshot } = workspace;
  const board = loadBoard(snapshot, config);
  const out = (text: string, data?: unknown) => process.stdout.write(values.json && data !== undefined ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
  const write = (changes: { path: string; content: string | null }[]) => applyChanges(root, changes);
  const unwrap = <T extends { ok: true }>(result: T | { ok: false; error: string; missing?: { section: string; question: string }[] }): T => {
    if (!result.ok) fail(`${result.error}${result.missing?.length ? `\nMissing: ${result.missing.map((question) => question.section).join(', ')}` : ''}`);
    return result;
  };

  switch (command) {
    case 'init': {
      const changes: FileChange[] = workspace.hasConfigFile ? [] : [{ path: CONFIG_PATH, content: serializeConfig(config) }];
      changes.push(...boardChanges(board, config, [], board.boards.keys()));
      out(changes.length ? `Wrote ${write(changes).join(', ')}` : 'Already set up.');
      return;
    }
    case 'board': {
      const changes = boardChanges(board, config, [], board.boards.keys());
      out(changes.length ? `Regenerated ${write(changes).join(', ')}` : 'Board files are up to date.');
      return;
    }
    case 'lanes': {
      if (!rest.length) {
        out(config.lanes.join(' → '), config.lanes);
        return;
      }
      const rename: Record<string, string> = {};
      for (const pair of values.rename ?? []) {
        const [from, to] = pair.split('=');
        if (!from || !to) fail(`--rename "${pair}" must look like OLD=NEW.`);
        rename[from] = to;
      }
      const changed = unwrap(changeLanes(board, config, { lanes: rest, rename, today: today() }));
      write(changed.changes);
      out(`Lanes are now ${changed.config.lanes.join(' → ')}.${changed.moved.length ? ` Moved ${changed.moved.length} issue(s).` : ''}`);
      return;
    }
    case 'list': {
      const found = searchIssues(board, config, {
        board: values.board === undefined ? undefined : values.board === 'main' ? '' : values.board,
        lane: values.lane,
        text: values.text,
        includeArchived: values.archived,
      });
      out(
        found.map((issue) => `${formatId(issue.board, issue.number)}\t${issue.frontmatter.status}\t${issue.frontmatter.title}\t${issue.path}`).join('\n') || 'No issues match.',
        found.map((issue) => ({ id: formatId(issue.board, issue.number), ...issue })),
      );
      return;
    }
    case 'show': {
      const ref = requireRef(rest[0]);
      const issue = findIssue(board, ref) ?? fail(`issue ${formatId(ref.board, ref.number)} doesn't exist.`);
      out(`${issue.path}\n\n${serializeIssue(issue)}`, issue);
      return;
    }
    case 'context': {
      const ref = requireRef(rest[0]);
      const pack = contextPack(board, snapshot.files, config.docs, ref) ?? fail(`issue ${formatId(ref.board, ref.number)} doesn't exist.`);
      const line = (issue: { board: string; number: number; path: string; frontmatter: { title: string; status: string } }) =>
        `- ${formatId(issue.board, issue.number)} [${issue.frontmatter.status}] ${issue.frontmatter.title} — ${issue.path}`;
      out(
        [
          `${pack.issue.path}\n\n${serializeIssue(pack.issue)}`,
          pack.parent ? `Parent:\n${line(pack.parent)}` : '',
          pack.children.length ? `Sub-issues:\n${pack.children.map(line).join('\n')}` : '',
          pack.linked.length ? `Linked:\n${pack.linked.map((entry) => `${line(entry.issue)} (${entry.relation})`).join('\n')}` : '',
          pack.mentions.length ? `Mentioned in:\n${pack.mentions.map((mention) => `- ${mention.path}:${mention.line} ${mention.excerpt}`).join('\n')}` : '',
          pack.files.length ? `Files named in Context:\n${pack.files.map((file) => `- ${file}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        pack,
      );
      return;
    }
    case 'create': {
      if (!values.title || !values.why) fail('create needs --title and --why.');
      if (values.type && !(ISSUE_TYPES as readonly string[]).includes(values.type)) fail(`--type must be one of ${ISSUE_TYPES.join(', ')}.`);
      if (values.board && !isBoardName(values.board)) fail(`"${values.board}" isn't a valid board name (kebab-case, like ANT-TEST).`);
      const parent = values.parent ? requireRef(values.parent) : undefined;
      const boardName = parent ? parent.board : (values.board ?? '');
      let number: number;
      if (values.number) {
        number = Number(values.number.replace(/^.*[_-]/, ''));
        if (!Number.isInteger(number) || number < 1) fail(`--number "${values.number}" isn't a number.`);
      } else if (values.offline) {
        number = (board.highest.get(boardName) ?? 0) + 1;
        process.stderr.write(`kanbai: offline number ${formatId(boardName, number)} may collide; run the MCP doctor after pushing.\n`);
      } else {
        fail('pass --number from the MCP\'s reserve_numbers tool (or --offline when it can\'t be reached).');
      }
      const created = unwrap(
        createIssue(
          board,
          config,
          number,
          {
            title: values.title,
            why: values.why,
            type: values.type as IssueType | undefined,
            status: values.status,
            doneWhen: values['done-when'],
            context: values.context,
            constraints: values.constraints,
            decisions: values.decisions,
            openQuestions: values['open-questions'],
            tags: values.tag,
            assignee: values.assignee,
          },
          { board: boardName, parent, today: today() },
        ),
      );
      write(created.changes);
      const missing = missingInfo(created.issue);
      out(
        `Created ${formatId(created.issue.board, created.issue.number)} ${created.issue.path}${missing.length ? `\nStill missing: ${missing.map((question) => question.section).join(', ')}` : ''}`,
        { id: formatId(created.issue.board, created.issue.number), path: created.issue.path, missing },
      );
      return;
    }
    case 'update': {
      const ref = requireRef(rest[0]);
      const sections: Record<string, string> = {};
      if (values.why !== undefined) sections.Why = values.why;
      if (values['done-when'] !== undefined) sections['Done when'] = values['done-when'];
      if (values.context !== undefined) sections.Context = values.context;
      if (values.constraints !== undefined) sections['Constraints / not doing'] = values.constraints;
      if (values.decisions !== undefined) sections.Decisions = values.decisions;
      if (values['open-questions'] !== undefined) sections['Open questions'] = values['open-questions'];
      const updated = unwrap(updateIssue(board, config, ref, { title: values.title, assignee: values.assignee, tags: values.tag, sections, note: values.note }, today()));
      write(updated.changes);
      out(`Updated ${formatId(ref.board, ref.number)}.`);
      return;
    }
    case 'move': {
      const ref = requireRef(rest[0]);
      const lane = rest[1] ?? fail('move needs a lane.');
      const moved = unwrap(moveIssue(board, config, ref, lane, { today: today(), reason: values.reason, actor: values.actor }));
      write(moved.changes);
      out(`Moved ${formatId(ref.board, ref.number)} from ${moved.from} to ${lane}.`);
      return;
    }
    case 'archive': {
      const ref = requireRef(rest[0]);
      const archived = unwrap(archiveIssue(board, config, ref, { today: today(), reason: values.reason }));
      write(archived.changes);
      out(`Archived ${formatId(ref.board, ref.number)}.`);
      return;
    }
    case 'comment': {
      const ref = requireRef(rest[0]);
      const commented = unwrap(addComment(board, config, ref, rest.slice(1).join(' '), today(), values.actor));
      write(commented.changes);
      out(`Comment added to ${formatId(ref.board, ref.number)}.`);
      return;
    }
    case 'doctor': {
      let report = runDoctor(snapshot, board, config, { today: today(), hasConfigFile: workspace.hasConfigFile });
      if (values['fix-all'] && report.numbersNeeded.size) {
        // Locally there is no dispenser: take numbers above the highest on each board.
        const numbers = new Map<string, number[]>();
        for (const [name, count] of report.numbersNeeded) {
          const start = (board.highest.get(name) ?? 0) + 1;
          numbers.set(name, Array.from({ length: count }, (_, index) => start + index));
        }
        report = runDoctor(snapshot, board, config, { today: today(), hasConfigFile: workspace.hasConfigFile, numbers });
        process.stderr.write('kanbai: renumbered with local numbers; prefer the MCP doctor (apply: "all"), which uses the dispenser.\n');
      }
      const lines = report.problems.map((problem) => `${problem.severity}\t${problem.fix}\t${problem.path ?? ''}\t${problem.message}`);
      if (values.fix || values['fix-all']) {
        const changes = values['fix-all'] ? [...report.safe, ...report.proposed] : report.safe;
        if (changes.length) write(changes);
      }
      out(lines.join('\n') || 'The board is healthy.', report);
      if (report.problems.some((problem) => problem.severity === 'error') && !values['fix-all']) process.exitCode = 2;
      return;
    }
    default:
      fail(`unknown command "${command}". Run kanbai --help.`);
  }
}

main(process.argv.slice(2));
