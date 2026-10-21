import { CONFIG_PATH, type BoardConfig, resolveConfig, serializeConfig } from './config.js';
import { type FileChange, type LoadedBoard, boardChanges, newIssuePath } from './board.js';
import {
  type Frontmatter,
  type Issue,
  type IssueLinks,
  type IssueType,
  LINK_KINDS,
  appendLog,
  getSection,
  hasContent,
  serializeIssue,
  setSection,
} from './issue.js';
import { formatId, isBoardName, slugify } from './naming.js';

export type OpError = { ok: false; error: string; missing?: Question[] };
export type OpResult<T = {}> = ({ ok: true; changes: FileChange[]; issue: Issue } & T) | OpError;

export interface Question {
  section: string;
  question: string;
}

/** An issue reference: board name ('' = main) plus number. */
export interface IssueRef {
  board: string;
  number: number;
}

export const idOf = (issue: Pick<Issue, 'board' | 'number'>) => formatId(issue.board, issue.number);

/** Writes the changed issues plus the board files they affect. */
function withBoards(board: LoadedBoard, config: BoardConfig, changed: Issue[]): FileChange[] {
  return [...changed.map((issue) => ({ path: issue.path, content: serializeIssue(issue) })), ...boardChanges(board, config, changed)];
}

export function findIssue(board: LoadedBoard, ref: IssueRef): Issue | undefined {
  return board.issues.find((issue) => issue.board === ref.board && issue.number === ref.number);
}

const notFound = (ref: IssueRef): OpError => ({ ok: false, error: `Issue ${formatId(ref.board, ref.number)} doesn't exist.` });

/** Plain questions for what an issue still lacks. Claude asks these in chat. */
export function missingInfo(issue: Issue): Question[] {
  const questions: Question[] = [];
  if (!hasContent(getSection(issue.body, 'Why'))) questions.push({ section: 'Why', question: 'Why does this matter: what goal or problem is behind it?' });
  if (!hasContent(getSection(issue.body, 'Done when'))) {
    questions.push({
      section: 'Done when',
      question:
        issue.frontmatter.type === 'bug' || issue.frontmatter.type === 'feature'
          ? 'What should be true when this is finished? Describe 3–5 concrete behaviours, including the edge cases that matter.'
          : 'What should be true when this is finished?',
    });
  }
  if (!hasContent(getSection(issue.body, 'Context'))) questions.push({ section: 'Context', question: 'Which files, docs or diagrams are relevant?' });
  return questions;
}

/** Every lane after the first needs Done when, except the archive. */
const doneWhenRequired = (config: BoardConfig, lane: string) => config.lanes.indexOf(lane) > 0 && lane !== config.archive;

/** Links point at issues on the same board. */
function validateLinks(board: LoadedBoard, boardName: string, links: IssueLinks | undefined, self?: number): string | undefined {
  for (const kind of LINK_KINDS) {
    for (const number of links?.[kind] ?? []) {
      if (number === self) return `An issue can't link to itself (${kind}: ${number}).`;
      if (!findIssue(board, { board: boardName, number })) return `Linked issue ${formatId(boardName, number)} (${kind}) doesn't exist.`;
    }
  }
  return undefined;
}

export interface IssueInput {
  title: string;
  why: string;
  type?: IssueType;
  status?: string;
  doneWhen?: string;
  context?: string;
  constraints?: string;
  decisions?: string;
  openQuestions?: string;
  tags?: string[];
  assignee?: string;
  links?: IssueLinks;
}

export interface CreateOptions {
  /** Board for a new top-level issue ('' = main). Sub-issues always use their parent's board. */
  board?: string;
  /** Parent issue for a sub-issue; it goes in the parent's folder. */
  parent?: IssueRef;
  today: string;
}

/**
 * Builds a new issue with a number already handed out by the dispenser for its board.
 * Pass `board` with the issues created earlier in the same batch to keep them together.
 */
export function createIssue(board: LoadedBoard, config: BoardConfig, number: number, input: IssueInput, options: CreateOptions): OpResult<{ missing: Question[] }> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: 'A title is required.' };
  if (!input.why.trim()) {
    return { ok: false, error: 'A Why is required: what goal or problem is behind this?', missing: [{ section: 'Why', question: 'Why does this matter?' }] };
  }
  let parent: Issue | undefined;
  if (options.parent) {
    parent = findIssue(board, options.parent);
    if (!parent) return notFound(options.parent);
  }
  const boardName = parent ? parent.board : (options.board ?? '');
  if (boardName && !isBoardName(boardName)) return { ok: false, error: `"${boardName}" isn't a valid board name: use kebab-case, like ANT-TEST.` };
  if (findIssue(board, { board: boardName, number })) return { ok: false, error: `Issue ${formatId(boardName, number)} already exists.` };
  const status = input.status ?? config.lanes[0]!;
  if (!config.lanes.includes(status) || status === config.archive) {
    return { ok: false, error: `New issues go in one of: ${config.lanes.filter((lane) => lane !== config.archive).join(', ')}.` };
  }
  if (doneWhenRequired(config, status) && !hasContent(input.doneWhen)) {
    return {
      ok: false,
      error: `An issue can only start in "${status}" when Done when is filled in. Leave out the status to file it as "${config.lanes[0]}".`,
      missing: [{ section: 'Done when', question: 'What should be true when this is finished?' }],
    };
  }
  const linkError = validateLinks(board, boardName, input.links, number);
  if (linkError) return { ok: false, error: linkError };

  let body = setSection('', 'Why', input.why);
  body = setSection(body, 'Done when', hasContent(input.doneWhen) ? input.doneWhen! : '- [ ] …');
  if (input.context?.trim()) body = setSection(body, 'Context', input.context);
  if (input.constraints?.trim()) body = setSection(body, 'Constraints / not doing', input.constraints);
  if (input.decisions?.trim()) body = setSection(body, 'Decisions', input.decisions);
  if (input.openQuestions?.trim()) body = setSection(body, 'Open questions', input.openQuestions);
  body = appendLog(body, options.today, parent ? `Created as a sub-issue of ${idOf(parent)}.` : 'Created.');

  const frontmatter: Frontmatter = {
    title,
    type: input.type ?? 'feature',
    status,
    created: options.today,
    tags: input.tags ?? [],
    links: input.links ?? {},
    attachments: [],
  };
  if (input.assignee) frontmatter.assignee = input.assignee.replace(/^@/, '');
  const slug = slugify(title);
  const issue: Issue = {
    board: boardName,
    number,
    slug,
    path: newIssuePath(board, config, boardName, number, slug, parent),
    ...(parent ? { parentPath: parent.path } : {}),
    frontmatter,
    body,
  };
  return { ok: true, issue, changes: withBoards(board, config, [issue]), missing: missingInfo(issue) };
}

/** Adds freshly created issues to a loaded board, so the next item in a batch sees them. */
export function withIssues(board: LoadedBoard, issues: Issue[]): LoadedBoard {
  const highest = new Map(board.highest);
  for (const issue of issues) highest.set(issue.board, Math.max(highest.get(issue.board) ?? 0, issue.number));
  const paths = new Set(issues.map((issue) => issue.path));
  return { ...board, issues: [...board.issues.filter((issue) => !paths.has(issue.path)), ...issues], highest };
}

/** Merges the changes of several operations: later writes to the same path win. */
export function mergeChanges(...lists: FileChange[][]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const list of lists) for (const change of list) byPath.set(change.path, change);
  return [...byPath.values()];
}

export interface MoveOptions {
  today: string;
  reason?: string;
  /** GitHub login of whoever moves it; becomes the assignee when entering a lane named doing (any case) unassigned. */
  actor?: string;
}

export function moveIssue(board: LoadedBoard, config: BoardConfig, ref: IssueRef, lane: string, options: MoveOptions): OpResult<{ from: string }> {
  const current = findIssue(board, ref);
  if (!current) return notFound(ref);
  if (!config.lanes.includes(lane)) return { ok: false, error: `Unknown lane "${lane}". Lanes: ${config.lanes.join(', ')}.` };
  const from = current.frontmatter.status;
  if (from === lane) return { ok: false, error: `Issue ${idOf(current)} is already in "${lane}".` };
  const fromIndex = config.lanes.indexOf(from);
  const toIndex = config.lanes.indexOf(lane);
  const backwards = fromIndex !== -1 && toIndex < fromIndex;
  if (!backwards && doneWhenRequired(config, lane) && !hasContent(getSection(current.body, 'Done when'))) {
    return {
      ok: false,
      error: `Issue ${idOf(current)} can't move to "${lane}" yet: Done when is empty.`,
      missing: [{ section: 'Done when', question: 'What should be true when this is finished? Describe 3–5 concrete behaviours.' }],
    };
  }
  if (backwards && !options.reason?.trim()) {
    return { ok: false, error: `Moving back from "${from}" to "${lane}" needs a reason, which goes in the Log.` };
  }
  const frontmatter: Frontmatter = { ...current.frontmatter, status: lane };
  if (lane.toLowerCase() === 'doing' && !frontmatter.assignee && options.actor) frontmatter.assignee = options.actor;
  const verb = lane === config.archive ? 'Archived' : `Moved from ${from || 'nowhere'} to ${lane}`;
  const note = `${verb}${options.reason?.trim() ? `: ${options.reason.trim()}` : '.'}`;
  const issue: Issue = { ...current, frontmatter, body: appendLog(current.body, options.today, note) };
  return { ok: true, issue, from, changes: withBoards(board, config, [issue]) };
}

/** Deleting is archiving: the file and its number stay, the issue moves to the archive lane. */
export function archiveIssue(board: LoadedBoard, config: BoardConfig, ref: IssueRef, options: MoveOptions): OpResult<{ from: string }> {
  return moveIssue(board, config, ref, config.archive, options);
}

export interface IssueUpdate {
  title?: string;
  type?: IssueType;
  assignee?: string | null;
  tags?: string[];
  links?: IssueLinks;
  /** Section name → new content. Replaces the section. */
  sections?: Partial<Record<string, string>>;
  /** Why the change was made, for the Log. */
  note?: string;
}

/** Changes fields and sections. Lane changes go through moveIssue, so the rules always apply. */
export function updateIssue(board: LoadedBoard, config: BoardConfig, ref: IssueRef, update: IssueUpdate, today: string): OpResult<{ missing: Question[] }> {
  const current = findIssue(board, ref);
  if (!current) return notFound(ref);
  if (update.sections && Object.keys(update.sections).some((name) => name.toLowerCase() === 'log')) {
    return { ok: false, error: 'The Log is append-only: use add_comment.' };
  }
  const linkError = update.links ? validateLinks(board, current.board, update.links, current.number) : undefined;
  if (linkError) return { ok: false, error: linkError };
  const frontmatter: Frontmatter = { ...current.frontmatter };
  if (update.title !== undefined) {
    if (!update.title.trim()) return { ok: false, error: "The title can't be empty." };
    frontmatter.title = update.title.trim();
  }
  if (update.type) frontmatter.type = update.type;
  if (update.assignee === null || update.assignee === '') delete frontmatter.assignee;
  else if (update.assignee) frontmatter.assignee = update.assignee.replace(/^@/, '');
  if (update.tags) frontmatter.tags = update.tags;
  if (update.links) frontmatter.links = update.links;
  let body = current.body;
  const touched: string[] = [];
  for (const [name, content] of Object.entries(update.sections ?? {})) {
    if (content === undefined) continue;
    body = setSection(body, name, content);
    touched.push(name);
  }
  if (doneWhenRequired(config, frontmatter.status) && !hasContent(getSection(body, 'Done when'))) {
    return { ok: false, error: `Done when can't be emptied while the issue is in "${frontmatter.status}".` };
  }
  const changedFields = ['title', 'type', 'assignee', 'tags', 'links'].filter((key) => (update as Record<string, unknown>)[key] !== undefined);
  const summary = [...changedFields, ...touched].join(', ');
  if (!summary) return { ok: false, error: 'Nothing to change.' };
  body = appendLog(body, today, `Updated ${summary}${update.note?.trim() ? `: ${update.note.trim()}` : '.'}`);
  // The slug stays as it was at creation, so links never break. The number is the identity.
  const issue: Issue = { ...current, frontmatter, body };
  return { ok: true, issue, changes: withBoards(board, config, [issue]), missing: missingInfo(issue) };
}

export function addComment(board: LoadedBoard, config: BoardConfig, ref: IssueRef, text: string, today: string, author?: string): OpResult {
  const current = findIssue(board, ref);
  if (!current) return notFound(ref);
  if (!text.trim()) return { ok: false, error: 'The comment is empty.' };
  const issue: Issue = { ...current, body: appendLog(current.body, today, author ? `@${author}: ${text.trim()}` : text.trim()) };
  return { ok: true, issue, changes: withBoards(board, config, [issue]) };
}

// ------------------------------------------------------------------ search

export interface SearchQuery {
  text?: string;
  /** Board name; leave out for every board. Use '' for the main board only. */
  board?: string;
  lane?: string;
  type?: IssueType;
  tag?: string;
  assignee?: string;
  released?: string;
  /** Archived issues are left out unless asked for (or the lane is the archive). */
  includeArchived?: boolean;
}

export function searchIssues(board: LoadedBoard, config: BoardConfig, query: SearchQuery): Issue[] {
  const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return board.issues.filter((issue) => {
    const fm = issue.frontmatter;
    if (query.board !== undefined && issue.board !== query.board) return false;
    if (query.lane && fm.status !== query.lane) return false;
    if (!query.lane && !query.includeArchived && fm.status === config.archive) return false;
    if (query.type && fm.type !== query.type) return false;
    if (query.tag && !fm.tags.includes(query.tag)) return false;
    if (query.assignee && (fm.assignee ?? '').toLowerCase() !== query.assignee.replace(/^@/, '').toLowerCase()) return false;
    if (query.released && fm.released !== query.released) return false;
    if (!words.length) return true;
    const haystack = `${idOf(issue)} ${fm.title} ${fm.tags.join(' ')} ${issue.body}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Searches every markdown file in the docs folder, issues included. */
export function searchDocs(files: Record<string, string>, docsDir: string, text: string, limit = 20): { path: string; line: number; excerpt: string }[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: { path: string; line: number; excerpt: string; score: number }[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(`${docsDir}/`) || !/\.mdx?$/.test(path)) continue;
    const lower = content.toLowerCase();
    if (!words.every((word) => lower.includes(word))) continue;
    const lines = content.split('\n');
    const index = Math.max(0, lines.findIndex((line) => words.some((word) => line.toLowerCase().includes(word))));
    hits.push({ path, line: index + 1, excerpt: lines[index]!.trim().slice(0, 200), score: words.reduce((sum, word) => sum + lower.split(word).length - 1, 0) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

// ------------------------------------------------------------ context pack

export interface ContextPack {
  issue: Issue;
  parent?: Issue;
  children: Issue[];
  /** Issues this one links to, and issues that link to it. */
  linked: { issue: Issue; relation: string }[];
  /** Docs and issues that mention its id. */
  mentions: { path: string; line: number; excerpt: string }[];
  /** File paths named in the Context section, for the caller to fetch. */
  files: string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function contextPack(board: LoadedBoard, files: Record<string, string>, docsDir: string, ref: IssueRef): ContextPack | undefined {
  const issue = findIssue(board, ref);
  if (!issue) return undefined;
  const linked: ContextPack['linked'] = [];
  for (const kind of LINK_KINDS) {
    for (const target of issue.frontmatter.links[kind] ?? []) {
      const other = findIssue(board, { board: issue.board, number: target });
      if (other) linked.push({ issue: other, relation: kind });
    }
  }
  const reverse: Record<string, string> = { blocks: 'blocked by', relates: 'relates', parent: 'child' };
  for (const other of board.issues) {
    if (other.board !== issue.board || other.number === issue.number) continue;
    for (const kind of LINK_KINDS) {
      if (other.frontmatter.links[kind]?.includes(issue.number) && !linked.some((entry) => entry.issue.path === other.path)) {
        linked.push({ issue: other, relation: reverse[kind]! });
      }
    }
  }
  // Mentions of the id as a word: "012", "#012", "fixes 012" on the main board; "ANT-TEST_012" (or "ANT-TEST-012") on others.
  const id = idOf(issue);
  const pattern = issue.board
    ? new RegExp(`(?<![\\w-])${escapeRegExp(issue.board)}[_-]0*${issue.number}(?!\\d)`)
    : new RegExp(`(?<![\\w./-])#?${escapeRegExp(id)}(?![\\w])`);
  const mentions: ContextPack['mentions'] = [];
  for (const [path, content] of Object.entries(files)) {
    if (path === issue.path || !path.startsWith(`${docsDir}/`) || !/\.mdx?$/.test(path) || /000_board\.md$/.test(path)) continue;
    content.split('\n').forEach((line, index) => {
      if (pattern.test(line)) mentions.push({ path, line: index + 1, excerpt: line.trim().slice(0, 200) });
    });
  }
  const context = getSection(issue.body, 'Context') ?? '';
  const paths = new Set<string>();
  for (const match of context.matchAll(/`([^`\s]+\.[a-z0-9]+)`/gi)) paths.add(match[1]!);
  for (const match of context.matchAll(/\]\((?!https?:)([^)#\s]+)\)/gi)) paths.add(match[1]!);
  return {
    issue,
    parent: issue.parentPath ? board.issues.find((other) => other.path === issue.parentPath) : undefined,
    children: board.issues.filter((other) => other.parentPath === issue.path),
    linked,
    mentions: mentions.slice(0, 30),
    files: [...paths].slice(0, 20),
  };
}

// ------------------------------------------------------------- lanes

export interface LaneChange {
  /** The new lanes, in order. The archive lane is added last when missing. */
  lanes: string[];
  /** Old lane → new lane, for issues whose lane is renamed or dropped. */
  rename?: Record<string, string>;
  today: string;
}

/**
 * Changes a repo's lanes: writes `.board.json`, moves issues out of lanes that no longer exist
 * (by `rename`, otherwise to the first lane), and regenerates every board file.
 */
export function changeLanes(
  board: LoadedBoard,
  config: BoardConfig,
  change: LaneChange,
): { ok: true; config: BoardConfig; changes: FileChange[]; moved: { issue: Issue; from: string; to: string }[] } | OpError {
  const { archive: _archive, ...rest } = config;
  const resolved = resolveConfig(JSON.stringify({ ...rest, lanes: change.lanes }));
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const next = resolved.config;
  for (const [from, to] of Object.entries(change.rename ?? {})) {
    if (!next.lanes.includes(to)) return { ok: false, error: `rename: "${from}" → "${to}", but "${to}" isn't one of the new lanes.` };
  }
  const moved: { issue: Issue; from: string; to: string }[] = [];
  for (const issue of board.issues) {
    const from = issue.frontmatter.status;
    if (next.lanes.includes(from) && !change.rename?.[from]) continue;
    const to = change.rename?.[from] ?? (from === config.archive ? next.archive : next.lanes[0]!);
    if (to === from) continue;
    moved.push({
      issue: { ...issue, frontmatter: { ...issue.frontmatter, status: to }, body: appendLog(issue.body, change.today, `Lane "${from}" became "${to}" when the board's lanes changed.`) },
      from,
      to,
    });
  }
  const issues = moved.map((entry) => entry.issue);
  const changes: FileChange[] = [
    { path: CONFIG_PATH, content: serializeConfig(next) },
    ...issues.map((issue) => ({ path: issue.path, content: serializeIssue(issue) })),
    ...boardChanges(board, next, issues, board.boards.keys()),
  ];
  return { ok: true, config: next, changes, moved };
}
