/**
 * File and folder names on the board.
 *
 * Inside the board folder (`config.board`):
 *
 *   000_board.md                     the main board (generated)
 *   001_build-login.md               an issue on the main board
 *   001_build-login/002_api.md       a sub-issue (same board, own number)
 *   ANT-TEST_001_create-home.md      an issue on board ANT-TEST
 *   ANT-TEST_000_board.md            board ANT-TEST (generated, when it has no folder)
 *   ANT-TEST/001_create-home.md      also board ANT-TEST: folders and prefixes merge
 *   ANT-TEST/000_board.md            board ANT-TEST (generated, when it has a folder)
 *
 * A board name is kebab-case and case-sensitive (`ANT-TEST` and `ant-test` are different boards).
 * Numbers count per board; sub-issues take numbers from their board too.
 */

export const MAIN_BOARD = '';

const BOARD_NAME = '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*';
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const BOARD_NAME_RE = new RegExp(`^${BOARD_NAME}$`);
const ISSUE_STEM_RE = new RegExp(`^(?:(${BOARD_NAME})_)?(\\d{3,})_(${SLUG})$`);
const BOARD_FILE_RE = new RegExp(`^(?:(${BOARD_NAME})_)?000_board\\.md$`);

/** Folder names inside the board folder that are never boards. */
export const RESERVED_NAMES = new Set(['attachments']);

export const isBoardName = (name: string) => BOARD_NAME_RE.test(name) && !/^\d+$/.test(name) && !RESERVED_NAMES.has(name);

export const padNumber = (number: number) => String(number).padStart(3, '0');

/** Display id: `012` on the main board, `ANT-TEST_012` on another board. */
export function formatId(board: string, number: number): string {
  return board ? `${board}_${padNumber(number)}` : padNumber(number);
}

/** Accepts `12`, `012`, `ANT-TEST_012`, `ANT-TEST-012` and `ANT-TEST 12`. */
export function parseId(id: string): { board: string; number: number } | null {
  const match = new RegExp(`^(?:(${BOARD_NAME})[_ -])?0*(\\d+)$`).exec(id.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { board: match[1] ?? MAIN_BOARD, number };
}

export interface IssueLocation {
  board: string;
  number: number;
  slug: string;
  /** Path of the parent issue's file when this is a sub-issue. */
  parentPath?: string;
}

export type PathKind =
  | { kind: 'issue'; location: IssueLocation }
  | { kind: 'board-file'; board: string }
  | { kind: 'other' }
  | { kind: 'invalid'; reason: string };

const stem = (name: string) => name.replace(/\.md$/, '');

/** Classifies a markdown file inside the board folder. `relative` is relative to `config.board`. */
export function classifyPath(relative: string): PathKind {
  const segments = relative.split('/');
  const fileName = segments.pop()!;
  if (!fileName.endsWith('.md')) return { kind: 'other' };

  let board = MAIN_BOARD;
  let inBoardFolder = false;
  if (segments.length && isBoardName(segments[0]!) && !ISSUE_STEM_RE.test(segments[0]!)) {
    board = segments.shift()!;
    inBoardFolder = true;
  }

  const boardFile = BOARD_FILE_RE.exec(fileName);
  if (boardFile) {
    if (segments.length) return { kind: 'invalid', reason: 'A board file can only sit at the top of a board.' };
    const prefix = boardFile[1];
    if (inBoardFolder && prefix && prefix !== board) return { kind: 'invalid', reason: `Board file for "${prefix}" inside folder "${board}".` };
    return { kind: 'board-file', board: prefix ?? board };
  }

  const parentDirs: string[] = [];
  for (const [index, dir] of segments.entries()) {
    const match = ISSUE_STEM_RE.exec(dir);
    if (!match) {
      return { kind: 'invalid', reason: `Folder "${dir}" is neither a board (kebab-case name) nor an issue (NNN_slug).` };
    }
    const prefix = match[1];
    if (prefix) {
      if (index === 0 && !inBoardFolder && board === MAIN_BOARD) board = prefix;
      else if (prefix !== board) return { kind: 'invalid', reason: `"${dir}" names board "${prefix}" inside board "${board || 'main'}".` };
    }
    parentDirs.push(dir);
  }

  const match = ISSUE_STEM_RE.exec(stem(fileName));
  if (!match) return { kind: 'invalid', reason: `"${fileName}" doesn't follow NNN_slug.md (optionally BOARD_NNN_slug.md).` };
  const [, prefix, digits, slug] = match;
  if (prefix) {
    if (!inBoardFolder && board === MAIN_BOARD && !parentDirs.length) board = prefix;
    else if (prefix !== board) return { kind: 'invalid', reason: `"${fileName}" names board "${prefix}" inside board "${board || 'main'}".` };
  }
  const number = Number(digits);
  if (number === 0) return { kind: 'invalid', reason: 'Number 000 is reserved for board files.' };

  const location: IssueLocation = { board, number, slug: slug! };
  if (parentDirs.length) {
    const folder = [...(inBoardFolder ? [board] : []), ...parentDirs].join('/');
    location.parentPath = `${folder}.md`;
  }
  return { kind: 'issue', location };
}

export function slugify(title: string, maxLength = 48): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'issue';
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  return cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
}

/**
 * Where a new issue goes, relative to `config.board`.
 * - Sub-issue: inside the parent's folder (`<parent stem>/NNN_slug.md`).
 * - Board with a folder: `BOARD/NNN_slug.md`.
 * - Other board: `BOARD_NNN_slug.md`. Main board: `NNN_slug.md`.
 */
export function newIssueRelativePath(options: { board: string; number: number; slug: string; parentRelative?: string; boardHasFolder: boolean }): string {
  const file = `${padNumber(options.number)}_${options.slug}.md`;
  if (options.parentRelative) return `${stem(options.parentRelative)}/${file}`;
  if (!options.board) return file;
  return options.boardHasFolder ? `${options.board}/${file}` : `${options.board}_${file}`;
}

export function boardFileRelativePath(board: string, boardHasFolder: boolean): string {
  if (!board) return '000_board.md';
  return boardHasFolder ? `${board}/000_board.md` : `${board}_000_board.md`;
}
