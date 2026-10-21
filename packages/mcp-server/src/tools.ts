import { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  type BoardConfig,
  type FileChange,
  type Issue,
  type IssueInput,
  type IssueLinks,
  type Question,
  ISSUE_TYPES,
  addComment,
  archiveIssue,
  boardChanges,
  DEFAULT_PUBLISH_BRANCH,
  type PublishEvent,
  compareVersionsDesc,
  matchesTagPattern,
  parseEvent,
  publishStatuses,
  changeLanes,
  contextPack,
  createIssue,
  findIssue,
  formatId,
  getBoard,
  isBoardName,
  loadBoard,
  mergeChanges,
  missingInfo,
  moveIssue,
  parseId,
  renderBoard,
  resolveConfig,
  runDoctor,
  searchDocs,
  searchIssues,
  serializeConfig,
  serializeIssue,
  updateIssue,
  withIssues,
} from '@kanbai/core';
import { z } from 'zod';
import type { Props } from './env.js';
import type { Env } from './env.js';
import { GitHubError, parseRepo } from './github.js';
import { type RepoState, RepoSession, UserError } from './repo.js';

const today = () => new Date().toISOString().slice(0, 10);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });
const fail = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }], isError: true });

/** Runs a tool body; known problems become readable errors instead of crashes. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UserError || error instanceof GitHubError) return fail(error.message);
    throw error;
  }
}

// ------------------------------------------------------------------ schemas

const repoArg = z.string().optional().describe('GitHub repo as owner/name. Leave out to use the default repo (see set_default_repo).');
const idArg = z.string().describe('Issue id: "012" on the main board, "ANT-TEST_012" on board ANT-TEST.');
const boardArg = z
  .string()
  .optional()
  .describe('Board name, kebab-case and case-sensitive, e.g. ANT-TEST. Leave out for the main board.');
const linksArg = z
  .object({
    blocks: z.array(z.number().int().positive()).optional(),
    relates: z.array(z.number().int().positive()).optional(),
    parent: z.array(z.number().int().positive()).optional(),
  })
  .optional()
  .describe('Links to other issues on the same board, by number. "parent" groups bigger features (like epics); for real sub-issues use the parent argument instead.');

const issueFields = {
  title: z.string().describe('Short imperative title, e.g. "Add dark mode toggle".'),
  why: z.string().describe('The goal or problem behind it. Required: without a why, an issue can\'t be refined later.'),
  type: z.enum(ISSUE_TYPES).optional().describe('Default: feature.'),
  status: z.string().optional().describe('Lane to start in. Default: the first lane. Any lane after the first needs done_when.'),
  done_when: z
    .string()
    .optional()
    .describe('What must be true when finished. For user-facing work: 3–5 concrete behaviours as plain sentences in a checklist ("- [ ] Adding an issue … creates …"). For refactors: a plain checklist.'),
  context: z.string().optional().describe('Files, docs, diagrams to look at. Put file paths in backticks so the context pack can fetch them.'),
  constraints: z.string().optional().describe('What not to touch, patterns to follow, non-goals.'),
  decisions: z.string().optional().describe('What is already decided, so nobody re-proposes alternatives.'),
  open_questions: z.string().optional().describe('What is still unclear. Gaps go here when the user is in a hurry.'),
  tags: z.array(z.string()).optional(),
  assignee: z.string().optional().describe('GitHub username.'),
  links: linksArg,
};

const sectionsArg = z
  .object({
    why: z.string().optional(),
    done_when: z.string().optional(),
    context: z.string().optional(),
    constraints: z.string().optional(),
    decisions: z.string().optional(),
    open_questions: z.string().optional(),
  })
  .optional()
  .describe('Sections to replace. The Log is append-only: use add_comment.');

const SECTION_NAMES: Record<string, string> = {
  why: 'Why',
  done_when: 'Done when',
  context: 'Context',
  constraints: 'Constraints / not doing',
  decisions: 'Decisions',
  open_questions: 'Open questions',
};

type IssueArgs = {
  title: string;
  why: string;
  type?: IssueInput['type'];
  status?: string;
  done_when?: string;
  context?: string;
  constraints?: string;
  decisions?: string;
  open_questions?: string;
  tags?: string[];
  assignee?: string;
  links?: IssueLinks;
};

const toInput = (args: IssueArgs): IssueInput => ({
  title: args.title,
  why: args.why,
  type: args.type,
  status: args.status,
  doneWhen: args.done_when,
  context: args.context,
  constraints: args.constraints,
  decisions: args.decisions,
  openQuestions: args.open_questions,
  tags: args.tags,
  assignee: args.assignee,
  links: args.links,
});

// ---------------------------------------------------------------- formatting

const repoName = (state: RepoState) => `${state.repo.owner}/${state.repo.name}`;

function issueLine(issue: Issue): string {
  const fm = issue.frontmatter;
  const extras = [fm.type, fm.assignee ? `@${fm.assignee}` : '', ...fm.tags.map((tag) => `#${tag}`)].filter(Boolean).join(' ');
  return `- ${formatId(issue.board, issue.number)} [${fm.status}] ${fm.title}${extras ? ` (${extras})` : ''} — ${issue.path}`;
}

function questionsText(questions: Question[]): string {
  if (!questions.length) return '';
  return `\n\nStill missing (ask the user, then call update_issue):\n${questions.map((question) => `- ${question.section}: ${question.question}`).join('\n')}`;
}

function commitText(commit: { oid: string; url: string } | undefined): string {
  return commit ? `\n\nCommitted ${commit.oid.slice(0, 7)}: ${commit.url}` : '\n\nNothing to commit.';
}

function requireId(value: string, defaultBoard = ''): { board: string; number: number } {
  const ref = parseId(value);
  if (!ref) throw new UserError(`"${value}" isn't an issue id. Use 012, or BOARD_012 for another board.`);
  return ref.board ? ref : { board: defaultBoard, number: ref.number };
}

function requireBoard(value: string | undefined): string {
  const board = value?.trim() ?? '';
  if (board && !isBoardName(board)) throw new UserError(`"${board}" isn't a valid board name: use kebab-case, like ANT-TEST.`);
  return board;
}

function unwrap<T extends { ok: true }>(result: T | { ok: false; error: string; missing?: Question[] }): T {
  if (!result.ok) throw new UserError(`${result.error}${questionsText(result.missing ?? [])}`);
  return result;
}

// --------------------------------------------------------------------- tools

export function createServer(env: Env, props: Props): McpServer {
  const server = new McpServer(
    { name: 'kanbai', version: '0.1.0' },
    {
      instructions: [
        'kanbai keeps a kanban board and docs as markdown in a GitHub repo.',
        'Issue ids are atomic: never invent a number, always let create_issue / create_issues / reserve_numbers hand them out.',
        'When a conversation reaches a conclusion worth keeping, file it with create_issue. Only title and why are required; fill the rest from the conversation.',
        'When create_issue reports missing information, ask the user those questions in chat, then call update_issue.',
        'Before starting work on an issue, call context_pack. Never delete issues: archive_issue keeps the number.',
      ].join(' '),
    },
  );
  const session = new RepoSession(env, props);

  server.registerTool(
    'list_repos',
    { description: 'Lists the GitHub repos this login can write to, most recently pushed first.', inputSchema: z.object({ filter: z.string().optional() }) },
    ({ filter }) =>
      guard(async () => {
        const repos = await session.github.listRepos();
        const shown = repos.filter((repo) => !filter || repo.full_name.toLowerCase().includes(filter.toLowerCase())).slice(0, 50);
        return text(shown.map((repo) => `- ${repo.full_name}${repo.private ? ' (private)' : ''}${repo.description ? ` — ${repo.description}` : ''}`).join('\n') || 'No repos found.');
      }),
  );

  server.registerTool(
    'set_default_repo',
    { description: 'Sets the repo the other tools use when no repo is passed.', inputSchema: z.object({ repo: z.string().describe('owner/name') }) },
    ({ repo }) =>
      guard(async () => {
        const parsed = parseRepo(repo);
        if (!parsed) throw new UserError(`"${repo}" isn't a repo. Use owner/name.`);
        const state = await session.load(repo);
        await session.setDefaultRepo(parsed);
        const note = state.configSource === 'file' ? '' : `\n\nThis repo has no ${CONFIG_PATH} yet. Call init_board to set it up.`;
        return text(`Default repo is now ${repoName(state)} (board folder ${state.config.board}).${note}`);
      }),
  );

  server.registerTool(
    'init_board',
    {
      description: `Sets up a repo for kanbai: writes ${CONFIG_PATH} and the main board file. Safe to run again; it only adds what is missing.`,
      inputSchema: z.object({
        repo: repoArg,
        docs: z.string().optional().describe(`Docs folder. Default: ${DEFAULT_CONFIG.docs}.`),
        board: z.string().optional().describe('Board folder. Default: <docs>/board.'),
        lanes: z.array(z.string()).optional().describe(`Lanes in order. Default: ${DEFAULT_CONFIG.lanes.join(', ')}. The archive lane is added last when missing.`),
      }),
    },
    ({ repo, docs, board, lanes }) =>
      guard(async () => {
        const { result, commit } = await session.commit(repo, (state) => {
          const changes: FileChange[] = [];
          let config: BoardConfig = state.config;
          if (state.configSource !== 'file') {
            const raw: Record<string, unknown> = { ...state.config };
            if (docs) raw.docs = docs;
            if (board) raw.board = board;
            else if (docs) raw.board = `${docs.replace(/\/+$/, '')}/board`;
            if (lanes) {
              raw.lanes = lanes;
              delete raw.archive;
            }
            const resolved = resolveConfig(JSON.stringify(raw));
            if (!resolved.ok) throw new UserError(resolved.error);
            config = resolved.config;
            changes.push({ path: CONFIG_PATH, content: serializeConfig(config) });
          }
          const loaded = loadBoard(state.snapshot, config);
          changes.push(...boardChanges(loaded, config, [], loaded.boards.keys()));
          return { changes, headline: 'kanbai: set up the board', result: config };
        });
        return text(`Board ready in ${result.board} with lanes ${result.lanes.join(' → ')}.${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'set_lanes',
    {
      description:
        'Changes the columns of this repo\'s boards: writes .board.json, moves issues out of lanes that are renamed or dropped (by rename, otherwise to the first lane), and regenerates every board file, in one commit. The archive lane is always added last.',
      inputSchema: z.object({
        repo: repoArg,
        lanes: z.array(z.string()).min(1).describe('New lanes in order, e.g. ["TODO", "DOING", "REVIEW", "DONE"]. Kebab-case; case is kept as written.'),
        rename: z.record(z.string(), z.string()).optional().describe('Old lane → new lane, e.g. {"idea": "TODO"}. Issues in other dropped lanes go to the first lane.'),
      }),
    },
    ({ repo, lanes, rename }) =>
      guard(async () => {
        const { result, commit } = await session.commit(repo, (state) => {
          const changed = changeLanes(state.board, state.config, { lanes, rename, today: today() });
          if (!changed.ok) throw new UserError(changed.error);
          return { changes: changed.changes, headline: `kanbai: lanes ${changed.config.lanes.join(', ')}`, result: changed };
        });
        const moved = result.moved.length ? `\n\nMoved ${result.moved.length} issue(s): ${result.moved.map((entry) => `${formatId(entry.issue.board, entry.issue.number)} ${entry.from} → ${entry.to}`).join(', ')}.` : '';
        return text(`Lanes are now ${result.config.lanes.join(' → ')}.${moved}${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'get_board',
    {
      description: 'Shows a board: every lane with its issues, as it would be rendered in 000_board.md. Also lists the other boards.',
      inputSchema: z.object({ repo: repoArg, board: boardArg }),
    },
    ({ repo, board }) =>
      guard(async () => {
        const state = await session.load(repo);
        const name = requireBoard(board);
        const info = getBoard(state.board, state.config, name);
        const others = [...state.board.boards.keys()].filter((key) => key !== name).map((key) => key || '(main)');
        return text(
          `${renderBoard(state.board.issues, state.config, info)}\nRepo ${repoName(state)} at ${state.snapshot.commit.slice(0, 7)}. Other boards: ${others.join(', ') || 'none'}.`,
        );
      }),
  );

  server.registerTool(
    'create_issue',
    {
      description:
        'Files one issue with the next atomic number on its board, and updates the board file, in one commit. Use parent to file a sub-issue inside another issue\'s folder.',
      inputSchema: z.object({
        repo: repoArg,
        board: boardArg,
        parent: z.string().optional().describe('Id of the parent issue, to file this as its sub-issue (same board).'),
        ...issueFields,
      }),
    },
    (args) =>
      guard(async () => {
        const state = await session.load(args.repo);
        const parent = args.parent ? requireId(args.parent, requireBoard(args.board)) : undefined;
        const boardName = parent ? parent.board : requireBoard(args.board);
        const input = toInput(args);
        // Validate before taking a number, so mistakes don't burn numbers.
        unwrap(createIssue(state.board, state.config, Number.MAX_SAFE_INTEGER, input, { board: boardName, parent, today: today() }));
        const [number] = await session.reserveNumbers(state, boardName, 1);
        const { result, commit } = await session.commit(
          args.repo,
          (current) => {
            const created = unwrap(createIssue(current.board, current.config, number!, input, { board: boardName, parent, today: today() }));
            return { changes: created.changes, headline: `kanbai: create ${formatId(boardName, number!)} ${created.issue.frontmatter.title}`, result: created };
          },
          state,
        );
        return text(`Created ${formatId(boardName, number!)} "${result.issue.frontmatter.title}" in ${result.issue.frontmatter.status}: ${result.issue.path}${questionsText(result.missing)}${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'create_issues',
    {
      description:
        'Files several issues in one commit, with numbers reserved as a batch. Use it to split a feature into an issue with sub-issues: give the parent first, then children with parent_index pointing at it.',
      inputSchema: z.object({
        repo: repoArg,
        issues: z
          .array(
            z.object({
              board: boardArg,
              parent: z.string().optional().describe('Id of an existing parent issue.'),
              parent_index: z.number().int().min(0).optional().describe('Index (0-based) of an earlier issue in this batch to use as parent.'),
              ...issueFields,
            }),
          )
          .min(1)
          .max(50),
      }),
    },
    ({ repo, issues }) =>
      guard(async () => {
        const state = await session.load(repo);
        // Work out each item's board first, so numbers can be reserved per board in one go.
        const boards: string[] = [];
        issues.forEach((item, index) => {
          if (item.parent_index !== undefined) {
            if (item.parent_index >= index) throw new UserError(`Issue ${index}: parent_index must point at an earlier issue.`);
            boards.push(boards[item.parent_index]!);
          } else if (item.parent) boards.push(requireId(item.parent, requireBoard(item.board)).board);
          else boards.push(requireBoard(item.board));
        });
        const counts = new Map<string, number>();
        for (const board of boards) counts.set(board, (counts.get(board) ?? 0) + 1);
        const pools = new Map<string, number[]>();
        for (const [board, count] of counts) pools.set(board, await session.reserveNumbers(state, board, count));
        const numbers = boards.map((board) => pools.get(board)!.shift()!);

        const { result, commit } = await session.commit(
          repo,
          (current) => {
            let loaded = current.board;
            const created: Issue[] = [];
            const missing: string[] = [];
            let changes: FileChange[] = [];
            issues.forEach((item, index) => {
              const parentRef =
                item.parent_index !== undefined
                  ? { board: boards[item.parent_index]!, number: numbers[item.parent_index]! }
                  : item.parent
                    ? requireId(item.parent, boards[index])
                    : undefined;
              const outcome = createIssue(loaded, current.config, numbers[index]!, toInput(item), { board: boards[index], parent: parentRef, today: today() });
              if (!outcome.ok) throw new UserError(`Issue ${index} ("${item.title}"): ${outcome.error}`);
              created.push(outcome.issue);
              loaded = withIssues(loaded, [outcome.issue]);
              changes = mergeChanges(changes, outcome.changes);
              if (outcome.missing.length) missing.push(`${formatId(outcome.issue.board, outcome.issue.number)}: ${outcome.missing.map((question) => question.section).join(', ')}`);
            });
            return { changes, headline: `kanbai: create ${created.length} issues`, body: created.map((issue) => `- ${formatId(issue.board, issue.number)} ${issue.frontmatter.title}`).join('\n'), result: { created, missing } };
          },
          state,
        );
        const lines = result.created.map(issueLine).join('\n');
        const gaps = result.missing.length ? `\n\nStill missing (ask the user, then call update_issue):\n${result.missing.map((line) => `- ${line}`).join('\n')}` : '';
        return text(`Created:\n${lines}${gaps}${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'reserve_numbers',
    {
      description:
        'Hands out atomic issue numbers without creating files, for the local flow (Claude Code writing issue files in a working copy). Name the files with these numbers; nobody else will get them.',
      inputSchema: z.object({ repo: repoArg, board: boardArg, count: z.number().int().min(1).max(100).default(1) }),
    },
    ({ repo, board, count }) =>
      guard(async () => {
        const state = await session.load(repo);
        const name = requireBoard(board);
        const numbers = await session.reserveNumbers(state, name, count ?? 1);
        return text(`Reserved on ${name || 'the main board'} of ${repoName(state)}: ${numbers.map((number) => formatId(name, number)).join(', ')}`);
      }),
  );

  server.registerTool(
    'read_issue',
    { description: 'Shows one issue in full: frontmatter and body.', inputSchema: z.object({ repo: repoArg, id: idArg }) },
    ({ repo, id }) =>
      guard(async () => {
        const state = await session.load(repo);
        const ref = requireId(id);
        const issue = findIssue(state.board, ref);
        if (!issue) throw new UserError(`Issue ${formatId(ref.board, ref.number)} doesn't exist in ${repoName(state)}.`);
        return text(`${issue.path}\n\n${serializeIssue(issue)}${questionsText(missingInfo(issue))}`);
      }),
  );

  server.registerTool(
    'update_issue',
    {
      description: 'Changes fields or replaces sections of an issue, with a Log line. To change the lane, use move_issue.',
      inputSchema: z.object({
        repo: repoArg,
        id: idArg,
        title: z.string().optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        assignee: z.string().nullable().optional().describe('GitHub username; null or "" to clear.'),
        tags: z.array(z.string()).optional(),
        links: linksArg,
        sections: sectionsArg,
        note: z.string().optional().describe('Why the change was made, for the Log.'),
      }),
    },
    (args) =>
      guard(async () => {
        const ref = requireId(args.id);
        const sections: Record<string, string> = {};
        for (const [key, value] of Object.entries(args.sections ?? {})) if (value !== undefined) sections[SECTION_NAMES[key]!] = value;
        const { result, commit } = await session.commit(args.repo, (state) => {
          const updated = unwrap(updateIssue(state.board, state.config, ref, { title: args.title, type: args.type, assignee: args.assignee, tags: args.tags, links: args.links, sections, note: args.note }, today()));
          return { changes: updated.changes, headline: `kanbai: update ${formatId(ref.board, ref.number)} ${updated.issue.frontmatter.title}`, result: updated };
        });
        return text(`Updated ${formatId(ref.board, ref.number)}.${questionsText(result.missing)}${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'move_issue',
    {
      description:
        'Moves an issue to another lane, checking the rules: leaving the first lane needs Done when; moving back needs a reason. Entering "doing" unassigned assigns the current user.',
      inputSchema: z.object({ repo: repoArg, id: idArg, lane: z.string(), reason: z.string().optional() }),
    },
    ({ repo, id, lane, reason }) =>
      guard(async () => {
        const ref = requireId(id);
        const { result, commit } = await session.commit(repo, (state) => {
          const moved = unwrap(moveIssue(state.board, state.config, ref, lane, { today: today(), reason, actor: props.login }));
          return { changes: moved.changes, headline: `kanbai: move ${formatId(ref.board, ref.number)} to ${lane}`, result: moved };
        });
        return text(`Moved ${formatId(ref.board, ref.number)} "${result.issue.frontmatter.title}" from ${result.from} to ${lane}.${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'archive_issue',
    {
      description: 'The way to delete an issue: moves it to the archive lane. The file and its number stay, so references keep working.',
      inputSchema: z.object({ repo: repoArg, id: idArg, reason: z.string().optional() }),
    },
    ({ repo, id, reason }) =>
      guard(async () => {
        const ref = requireId(id);
        const { result, commit } = await session.commit(repo, (state) => {
          const archived = unwrap(archiveIssue(state.board, state.config, ref, { today: today(), reason, actor: props.login }));
          return { changes: archived.changes, headline: `kanbai: archive ${formatId(ref.board, ref.number)}`, result: archived };
        });
        return text(`Archived ${formatId(ref.board, ref.number)} "${result.issue.frontmatter.title}".${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'add_comment',
    { description: 'Adds a dated comment to an issue\'s Log.', inputSchema: z.object({ repo: repoArg, id: idArg, text: z.string() }) },
    ({ repo, id, text: comment }) =>
      guard(async () => {
        const ref = requireId(id);
        const { commit } = await session.commit(repo, (state) => {
          const commented = unwrap(addComment(state.board, state.config, ref, comment, today(), props.login));
          return { changes: commented.changes, headline: `kanbai: comment on ${formatId(ref.board, ref.number)}`, result: commented };
        });
        return text(`Comment added to ${formatId(ref.board, ref.number)}.${commitText(commit)}`);
      }),
  );

  server.registerTool(
    'search_issues',
    {
      description: 'Finds issues by text and filters. Archived issues are left out unless include_archived is set or lane is the archive lane.',
      inputSchema: z.object({
        repo: repoArg,
        text: z.string().optional(),
        board: z.string().optional().describe('Board name; leave out for every board; "main" for the main board.'),
        lane: z.string().optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        tag: z.string().optional(),
        assignee: z.string().optional(),
        released: z.string().optional(),
        include_archived: z.boolean().optional(),
      }),
    },
    (args) =>
      guard(async () => {
        const state = await session.load(args.repo);
        const board = args.board === undefined ? undefined : args.board === 'main' ? '' : requireBoard(args.board);
        const found = searchIssues(state.board, state.config, {
          text: args.text,
          board,
          lane: args.lane,
          type: args.type,
          tag: args.tag,
          assignee: args.assignee,
          released: args.released,
          includeArchived: args.include_archived,
        });
        return text(found.length ? `${found.length} issue(s):\n${found.slice(0, 100).map(issueLine).join('\n')}` : 'No issues match.');
      }),
  );

  server.registerTool(
    'search_docs',
    { description: 'Searches every markdown file in the docs folder, issues included.', inputSchema: z.object({ repo: repoArg, text: z.string() }) },
    ({ repo, text: query }) =>
      guard(async () => {
        const state = await session.load(repo);
        const hits = searchDocs(state.snapshot.files, state.config.docs, query);
        return text(hits.length ? hits.map((hit) => `- ${hit.path}:${hit.line} — ${hit.excerpt}`).join('\n') : 'Nothing found.');
      }),
  );

  server.registerTool(
    'context_pack',
    {
      description:
        'Everything needed to start work on an issue, in one go: the issue, its parent and sub-issues, linked issues, docs that mention it, and the files named in its Context section.',
      inputSchema: z.object({ repo: repoArg, id: idArg }),
    },
    ({ repo, id }) =>
      guard(async () => {
        const state = await session.load(repo);
        const ref = requireId(id);
        const pack = contextPack(state.board, state.snapshot.files, state.config.docs, ref);
        if (!pack) throw new UserError(`Issue ${formatId(ref.board, ref.number)} doesn't exist in ${repoName(state)}.`);
        const parts = [`# ${formatId(pack.issue.board, pack.issue.number)} ${pack.issue.frontmatter.title}`, `${pack.issue.path}\n\n${serializeIssue(pack.issue)}`];
        if (pack.parent) parts.push(`## Parent\n\n${issueLine(pack.parent)}\n\n${pack.parent.body}`);
        if (pack.children.length) parts.push(`## Sub-issues\n\n${pack.children.map(issueLine).join('\n')}`);
        if (pack.linked.length) parts.push(`## Linked issues\n\n${pack.linked.map((entry) => `${issueLine(entry.issue)} — ${entry.relation}\n\n${entry.issue.body}`).join('\n\n')}`);
        if (pack.mentions.length) parts.push(`## Mentioned in\n\n${pack.mentions.map((mention) => `- ${mention.path}:${mention.line} — ${mention.excerpt}`).join('\n')}`);
        for (const path of pack.files.slice(0, 10)) {
          const repoPath = path.startsWith('./') || path.startsWith('../') ? resolveFrom(pack.issue.path, path) : path.replace(/^\//, '');
          const content = state.snapshot.files[repoPath] ?? (await session.github.readFile(state.repo, state.snapshot.commit, repoPath));
          parts.push(content === null ? `## ${repoPath}\n\n(not found at this commit)` : `## ${repoPath}\n\n\`\`\`\n${content}\n\`\`\``);
        }
        return text(parts.join('\n\n'));
      }),
  );

  server.registerTool(
    'tag_release',
    {
      description:
        'Creates the next version tag on the default branch\'s latest commit, so a client can publish it (kanbai publish, or /publish in Claude Code). Pass bump (major, minor, patch) or an explicit tag. Without confirm it only shows a preview; show that to the user and call again with confirm: true.',
      inputSchema: z.object({
        repo: repoArg,
        bump: z.enum(['major', 'minor', 'patch']).optional(),
        tag: z.string().optional().describe('Explicit tag, e.g. v2.0.0-beta.1. Overrides bump.'),
        confirm: z.boolean().optional(),
      }),
    },
    ({ repo, bump, tag, confirm }) =>
      guard(async () => {
        const state = await session.load(repo);
        const pattern = state.config.publish?.tags ?? 'v*';
        const data = await session.github.publishData(state.repo, state.config.publish?.branch ?? DEFAULT_PUBLISH_BRANCH);
        const versions = data.tags.map((entry) => entry.tag).filter((name) => matchesTagPattern(name, pattern)).sort(compareVersionsDesc);
        const latest = versions.find((name) => /\d+\.\d+\.\d+$/.test(name));
        let next = tag?.trim();
        if (!next) {
          if (!bump) throw new UserError('Pass bump (major, minor or patch) or an explicit tag.');
          const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : 'v';
          const match = latest ? /(\d+)\.(\d+)\.(\d+)$/.exec(latest) : null;
          const [major, minor, patch] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
          const version = bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
          next = latest ? latest.replace(/\d+\.\d+\.\d+$/, version) : `${prefix}${version}`;
        }
        if (!/^[\w.+-]+(\/[\w.+-]+)*$/.test(next)) throw new UserError(`"${next}" isn't a valid tag name.`);
        if (data.tags.some((entry) => entry.tag === next)) throw new UserError(`Tag ${next} already exists.`);
        if (!matchesTagPattern(next, pattern)) throw new UserError(`${next} doesn't match the publish pattern "${pattern}", so kanbai publish wouldn't pick it up.`);
        const head = state.snapshot.commit;
        if (!confirm) {
          return text(`Preview: tag ${next} on ${state.branch} at ${head.slice(0, 7)} (latest is ${latest ?? 'none'}). Creating it lets the next kanbai publish deploy it. Call again with confirm: true to create it.`);
        }
        await session.github.createTag(state.repo, next, head);
        return text(`Created tag ${next} on ${state.branch} at ${head.slice(0, 7)}. Run /publish in Claude Code (or kanbai publish on your computer) to build and deploy it.`);
      }),
  );

  server.registerTool(
    'publish_status',
    {
      description:
        'Shows the git-based publish pipeline per version tag: pending, building (who and where), done, failed (with the end of the log) or superseded. Read-only: publishing itself runs on a client with `kanbai publish` or /publish in Claude Code.',
      inputSchema: z.object({ repo: repoArg }),
    },
    ({ repo }) =>
      guard(async () => {
        const state = await session.load(repo);
        const pattern = state.config.publish?.tags ?? 'v*';
        const branch = state.config.publish?.branch ?? DEFAULT_PUBLISH_BRANCH;
        const data = await session.github.publishData(state.repo, branch);
        const events = data.messages.map((message) => parseEvent(message.trim())).filter((event): event is PublishEvent => !!event);
        const statuses = publishStatuses(data.tags.filter((entry) => matchesTagPattern(entry.tag, pattern)), events);
        if (!statuses.length) return text(`No tags match "${pattern}" in ${repoName(state)}.`);
        const lines = statuses.slice(0, 20).map((status) => {
          const marker = status.lock ?? status.done ?? status.failed;
          const who = marker ? ` — ${marker.by} on ${marker.host}, ${marker.at}` : '';
          const log = status.state === 'failed' && status.failed?.log ? `\n  exit ${status.failed.exitCode}, last output:\n${status.failed.log.split('\n').slice(-10).map((line) => `    ${line}`).join('\n')}` : '';
          return `- ${status.tag} ${status.state}${who}${log}`;
        });
        const setup = state.config.publish ? '' : `\n\n${repoName(state)} has no "publish" section in .board.json yet, so clients can't publish it.`;
        return text(`${lines.join('\n')}${setup}`);
      }),
  );

  server.registerTool(
    'doctor',
    {
      description:
        'Checks the board for problems after edits made outside kanbai (hand-made files, pushes from other machines) and fixes them. apply: "none" only reports, "safe" applies the safe fixes (board files, broken frontmatter, the number counter), "all" also renumbers duplicates and creates a missing config. Show the user the report before using "all".',
      inputSchema: z.object({ repo: repoArg, apply: z.enum(['none', 'safe', 'all']).default('none') }),
    },
    ({ repo, apply }) =>
      guard(async () => {
        const state = await session.load(repo);
        const boards = [...state.board.boards.keys()];
        const peek = await session.peekNumbers(state, boards);
        const options = { today: today(), dispenserNext: new Map(Object.entries(peek)), hasConfigFile: state.configSource === 'file' };
        let report = runDoctor(state.snapshot, state.board, state.config, options);
        if (apply === 'all' && report.numbersNeeded.size) {
          const numbers = new Map<string, number[]>();
          for (const [board, count] of report.numbersNeeded) numbers.set(board, await session.reserveNumbers(state, board, count));
          report = runDoctor(state.snapshot, state.board, state.config, { ...options, numbers });
        }
        const lines = report.problems.map((problem) => `- [${problem.severity}${problem.fix === 'manual' ? ', fix by hand' : problem.fix === 'proposed' ? ', needs apply: all' : ''}] ${problem.path ? `${problem.path}: ` : ''}${problem.message}`);
        let commitNote = '';
        if (apply !== 'none') {
          for (const board of boards) {
            const highest = state.board.highest.get(board) ?? 0;
            if ((peek[board] ?? 1) <= highest) await session.bumpNumbers(state, board, highest + 1);
          }
          const changes = apply === 'all' ? mergeChanges(report.safe, report.proposed) : report.safe;
          if (changes.length) {
            const original = state.snapshot.commit;
            const { commit } = await session.commit(
              repo,
              (current) => {
                if (current.snapshot.commit !== original) throw new UserError('The repo changed while the doctor ran. Run it again.');
                return { changes, headline: 'kanbai: doctor fixes', body: report.problems.map((problem) => `- ${problem.message}`).join('\n'), result: null };
              },
              state,
            );
            commitNote = commitText(commit);
          } else commitNote = '\n\nNothing to commit.';
        }
        const summary = report.problems.length ? `${report.problems.length} finding(s) in ${repoName(state)}:\n${lines.join('\n')}` : `The board in ${repoName(state)} is healthy.`;
        return text(`${summary}${apply === 'none' && (report.safe.length || report.proposed.length) ? '\n\nRun again with apply: "safe" (or "all") to fix.' : ''}${commitNote}`);
      }),
  );

  return server;
}

function resolveFrom(fromFile: string, link: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of link.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}
