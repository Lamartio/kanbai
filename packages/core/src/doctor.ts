import { CONFIG_PATH, type BoardConfig, serializeConfig } from './config.js';
import { type FileChange, type LoadedBoard, type Snapshot, boardChanges } from './board.js';
import { type Issue, LINK_KINDS, appendLog, serializeIssue } from './issue.js';
import { formatId, padNumber } from './naming.js';

export type Severity = 'error' | 'warning' | 'info';
export type FixKind = 'auto' | 'proposed' | 'manual';

export interface Problem {
  code:
    | 'invalid-file'
    | 'duplicate-number'
    | 'unknown-lane'
    | 'missing-title'
    | 'board-out-of-sync'
    | 'extra-board-file'
    | 'missing-link-target'
    | 'missing-parent'
    | 'dispenser-behind'
    | 'missing-config'
    | 'broken-link';
  severity: Severity;
  message: string;
  path?: string;
  fix: FixKind;
}

export interface DoctorOptions {
  today: string;
  /** Next number the dispenser would hand out, per board. Used to spot a dispenser that fell behind. */
  dispenserNext?: Map<string, number>;
  /** Fresh numbers per board, for renumbering duplicates. Without them, renumbering is only described. */
  numbers?: Map<string, number[]>;
  /** Whether `.board.json` exists. */
  hasConfigFile?: boolean;
}

export interface DoctorReport {
  problems: Problem[];
  /** Fixes that are always safe: regenerated board files, defaults for broken frontmatter. */
  safe: FileChange[];
  /** Fixes to show before applying: renumbering duplicates, creating `.board.json`. */
  proposed: FileChange[];
  /** How many fresh numbers each board needs to resolve duplicates. */
  numbersNeeded: Map<string, number>;
}

const titleFromSlug = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');

function resolveRelative(fromFile: string, link: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of link.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

export function runDoctor(snapshot: Snapshot, board: LoadedBoard, config: BoardConfig, options: DoctorOptions): DoctorReport {
  const problems: Problem[] = [];
  const fixedIssues = new Map<string, Issue>();
  const proposed: FileChange[] = [];
  const numbersNeeded = new Map<string, number>();
  const fix = (issue: Issue, note: string, change: (issue: Issue) => Issue) => {
    const base = fixedIssues.get(issue.path) ?? issue;
    const next = change(base);
    fixedIssues.set(issue.path, { ...next, body: appendLog(next.body, options.today, `Doctor: ${note}`) });
  };

  if (options.hasConfigFile === false) {
    problems.push({ code: 'missing-config', severity: 'info', message: `No ${CONFIG_PATH}: using ${config.board} with the default lanes.`, path: CONFIG_PATH, fix: 'proposed' });
    proposed.push({ path: CONFIG_PATH, content: serializeConfig(config) });
  }

  for (const entry of board.invalid) {
    problems.push({ code: 'invalid-file', severity: 'error', message: entry.error, path: entry.path, fix: 'manual' });
  }

  // Duplicates: the oldest issue keeps the number, the others get fresh ones.
  const groups = new Map<string, Issue[]>();
  for (const issue of board.issues) {
    const key = formatId(issue.board, issue.number);
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.frontmatter.created.localeCompare(b.frontmatter.created) || a.path.localeCompare(b.path));
    const [keeper, ...others] = sorted;
    for (const other of others) {
      const hasChildren = board.issues.some((issue) => issue.parentPath === other.path);
      if (hasChildren) {
        problems.push({ code: 'duplicate-number', severity: 'error', message: `${id} is used twice. ${other.path} has sub-issues, so renumber it by hand; ${keeper!.path} keeps ${id}.`, path: other.path, fix: 'manual' });
        continue;
      }
      const pool = options.numbers?.get(other.board);
      const fresh = pool?.shift();
      numbersNeeded.set(other.board, (numbersNeeded.get(other.board) ?? 0) + 1);
      if (fresh === undefined) {
        problems.push({ code: 'duplicate-number', severity: 'error', message: `${id} is used twice. ${keeper!.path} keeps it; ${other.path} needs a fresh number.`, path: other.path, fix: 'proposed' });
        continue;
      }
      const name = other.path.slice(other.path.lastIndexOf('/') + 1);
      const newName = name.replace(new RegExp(`(^|_)${padNumber(other.number)}_`), `$1${padNumber(fresh)}_`);
      const newPath = `${other.path.slice(0, other.path.lastIndexOf('/') + 1)}${newName}`;
      const renumbered: Issue = {
        ...other,
        number: fresh,
        path: newPath,
        body: appendLog(other.body, options.today, `Doctor: renumbered from ${id} to ${formatId(other.board, fresh)}, because ${keeper!.path} already had ${id}.`),
      };
      proposed.push({ path: other.path, content: null }, { path: newPath, content: serializeIssue(renumbered) });
      problems.push({ code: 'duplicate-number', severity: 'error', message: `${id} is used twice. ${keeper!.path} keeps it; ${other.path} becomes ${formatId(other.board, fresh)}. Check references to ${id} afterwards.`, path: other.path, fix: 'proposed' });
    }
  }

  for (const issue of board.issues) {
    const id = formatId(issue.board, issue.number);
    if (!config.lanes.includes(issue.frontmatter.status)) {
      const lane = config.lanes[0]!;
      problems.push({ code: 'unknown-lane', severity: 'warning', message: `${id} is in unknown lane "${issue.frontmatter.status}"; moved to "${lane}".`, path: issue.path, fix: 'auto' });
      fix(issue, `lane "${issue.frontmatter.status}" doesn't exist, moved to ${lane}.`, (current) => ({ ...current, frontmatter: { ...current.frontmatter, status: lane } }));
    }
    if (!issue.frontmatter.title.trim()) {
      const title = titleFromSlug(issue.slug);
      problems.push({ code: 'missing-title', severity: 'warning', message: `${id} has no title; set to "${title}".`, path: issue.path, fix: 'auto' });
      fix(issue, 'added a missing title from the file name.', (current) => ({ ...current, frontmatter: { ...current.frontmatter, title } }));
    }
    for (const kind of LINK_KINDS) {
      for (const number of issue.frontmatter.links[kind] ?? []) {
        if (!board.issues.some((other) => other.board === issue.board && other.number === number)) {
          problems.push({ code: 'missing-link-target', severity: 'warning', message: `${id} links (${kind}) to ${formatId(issue.board, number)}, which doesn't exist.`, path: issue.path, fix: 'manual' });
        }
      }
    }
    if (issue.parentPath && !snapshot.files[issue.parentPath]) {
      problems.push({ code: 'missing-parent', severity: 'warning', message: `${id} sits in a sub-issue folder, but its parent ${issue.parentPath} doesn't exist.`, path: issue.path, fix: 'manual' });
    }
  }

  // Broken relative links in board and docs markdown.
  for (const [path, content] of Object.entries(snapshot.files)) {
    if (!path.startsWith(`${config.docs}/`) || !/\.mdx?$/.test(path)) continue;
    for (const match of content.matchAll(/\]\((?!https?:|mailto:|#|\/)([^)\s#]+\.mdx?)(?:#[^)]*)?\)/g)) {
      const target = resolveRelative(path, decodeURI(match[1]!));
      if (!(target in snapshot.files) && target.startsWith(`${config.docs}/`)) {
        problems.push({ code: 'broken-link', severity: 'warning', message: `Link to ${match[1]} doesn't resolve.`, path, fix: 'manual' });
      }
    }
  }

  for (const [name, next] of options.dispenserNext ?? []) {
    const highest = board.highest.get(name) ?? 0;
    if (next <= highest) {
      problems.push({ code: 'dispenser-behind', severity: 'warning', message: `The number dispenser for ${name || 'the main board'} would hand out ${padNumber(next)}, but ${formatId(name, highest)} exists; it moves past it.`, fix: 'auto' });
    }
  }

  // Board files last, so they reflect the fixes above.
  const changed = [...fixedIssues.values()];
  const safe: FileChange[] = changed.map((issue) => ({ path: issue.path, content: serializeIssue(issue) }));
  const boardFixes = boardChanges(board, config, changed, board.boards.keys());
  for (const change of boardFixes) {
    const info = [...board.boards.values()].find((candidate) => candidate.filePath === change.path);
    problems.push({
      code: 'board-out-of-sync',
      severity: 'info',
      message: `${info?.text === undefined ? 'Created' : 'Regenerated'} ${change.path}.`,
      path: change.path,
      fix: 'auto',
    });
  }
  safe.push(...boardFixes);
  for (const info of board.boards.values()) {
    for (const extra of info.extraFiles) {
      problems.push({ code: 'extra-board-file', severity: 'info', message: `${extra} duplicates ${info.filePath}; removed.`, path: extra, fix: 'auto' });
      safe.push({ path: extra, content: null });
    }
  }
  return { problems, safe, proposed, numbersNeeded };
}
