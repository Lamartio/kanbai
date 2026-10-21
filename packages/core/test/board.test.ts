import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  type FileChange,
  type Snapshot,
  addComment,
  archiveIssue,
  contextPack,
  createIssue,
  getSection,
  loadBoard,
  moveIssue,
  resolveConfig,
  runDoctor,
  searchIssues,
  updateIssue,
  withIssues,
} from '../src/index.js';

const config = DEFAULT_CONFIG;
const today = '2026-10-21';

function issueText(fields: Record<string, string>, body = '## Why\n\nBecause.\n\n## Done when\n\n- [ ] …\n') {
  const yaml = Object.entries({ type: 'feature', status: 'idea', created: '2026-10-01', ...fields })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `---\n${yaml}\n---\n\n${body}`;
}

function snapshot(files: Record<string, string>): Snapshot {
  return { commit: 'abc', files };
}

function apply(snap: Snapshot, changes: FileChange[]): Snapshot {
  const files = { ...snap.files };
  for (const change of changes) {
    if (change.content === null) delete files[change.path];
    else files[change.path] = change.content;
  }
  return { ...snap, files };
}

describe('config', () => {
  it('appends the archive lane when lanes leave it out', () => {
    const result = resolveConfig(JSON.stringify({ lanes: ['TODO', 'DOING', 'DONE'] }));
    expect(result.ok && result.config.lanes).toEqual(['TODO', 'DOING', 'DONE', 'archived']);
  });

  it('falls back to wiki/board without a config', () => {
    const result = resolveConfig(undefined, ['wiki/board']);
    expect(result.ok && result.config.board).toBe('wiki/board');
  });

  it('rejects an archive lane that is not last', () => {
    expect(resolveConfig(JSON.stringify({ lanes: ['todo', 'archived', 'done'], archive: 'archived' })).ok).toBe(false);
  });
});

describe('creating issues', () => {
  it('files an idea with only a title and why, and lists it on the board', () => {
    const snap = snapshot({ 'docs/board/012_old.md': issueText({ title: 'Old' }) });
    const board = loadBoard(snap, config);
    const result = createIssue(board, config, 13, { title: 'Dark mode toggle', why: 'Night use.' }, { today });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issue.path).toBe('docs/board/013_dark-mode-toggle.md');
    expect(result.issue.frontmatter.status).toBe('idea');
    expect(result.missing.map((question) => question.section)).toEqual(['Done when', 'Context']);
    const boardFile = result.changes.find((change) => change.path === 'docs/board/000_board.md')!.content!;
    expect(boardFile).toContain('## Idea\n\n- [012 Old](./012_old.md)\n- [013 Dark mode toggle](./013_dark-mode-toggle.md)');
  });

  it('refuses to start past the first lane without Done when', () => {
    const result = createIssue(loadBoard(snapshot({}), config), config, 1, { title: 'X', why: 'Y', status: 'ready' }, { today });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing?.[0]?.section).toBe('Done when');
  });

  it('puts issues of another board under its prefix and generates its own board file', () => {
    const result = createIssue(loadBoard(snapshot({}), config), config, 1, { title: 'Create home', why: 'Start.' }, { board: 'ANT-TEST', today });
    expect(result.ok && result.issue.path).toBe('docs/board/ANT-TEST_001_create-home.md');
    const paths = result.ok ? result.changes.map((change) => change.path) : [];
    expect(paths).toContain('docs/board/ANT-TEST_000_board.md');
    expect(paths).not.toContain('docs/board/000_board.md');
  });

  it('uses the board folder when there is one', () => {
    const snap = snapshot({ 'docs/board/ANT-TEST/001_create-home.md': issueText({ title: 'Create home' }) });
    const result = createIssue(loadBoard(snap, config), config, 2, { title: 'About', why: 'Info.' }, { board: 'ANT-TEST', today });
    expect(result.ok && result.issue.path).toBe('docs/board/ANT-TEST/002_about.md');
    const boardFile = result.ok ? result.changes.find((change) => change.path === 'docs/board/ANT-TEST/000_board.md') : undefined;
    expect(boardFile?.content).toContain('- [ANT-TEST_002 About](./002_about.md)');
  });

  it('files sub-issues in the parent folder, without listing them on the board', () => {
    const snap = snapshot({ 'docs/board/ANT-TEST/001_create-home.md': issueText({ title: 'Create home' }) });
    const loaded = loadBoard(snap, config);
    const first = createIssue(loaded, config, 2, { title: 'Design', why: 'Look.' }, { parent: { board: 'ANT-TEST', number: 1 }, today });
    expect(first.ok && first.issue.path).toBe('docs/board/ANT-TEST/001_create-home/002_design.md');
    if (!first.ok) return;
    // A batch: the second sub-issue sees the first.
    const second = createIssue(withIssues(loaded, [first.issue]), config, 3, { title: 'Copy', why: 'Words.' }, { parent: { board: 'ANT-TEST', number: 1 }, today });
    expect(second.ok && second.issue.path).toBe('docs/board/ANT-TEST/001_create-home/003_copy.md');
    const boardFile = second.ok ? second.changes.find((change) => change.path.endsWith('000_board.md'))?.content : undefined;
    expect(boardFile ?? '').not.toContain('Copy');
    const reloaded = loadBoard(apply(snap, [...first.changes, ...(second.ok ? second.changes : [])]), config);
    const pack = contextPack(reloaded, apply(snap, first.changes).files, 'docs', { board: 'ANT-TEST', number: 1 });
    expect(pack?.children.map((child) => child.number)).toEqual([2, 3]);
  });
});

describe('moving issues', () => {
  const snap = snapshot({
    'docs/board/001_login.md': issueText({ title: 'Login' }),
    'docs/board/002_ready.md': issueText({ title: 'Ready one', status: 'ready' }, '## Why\n\nX.\n\n## Done when\n\n- [ ] Users can sign in\n'),
  });
  const board = loadBoard(snap, config);

  it('blocks leaving the first lane without Done when', () => {
    const result = moveIssue(board, config, { board: '', number: 1 }, 'ready', { today });
    expect(result.ok).toBe(false);
  });

  it('moves forward, sets the assignee entering doing, and logs it', () => {
    const result = moveIssue(board, config, { board: '', number: 2 }, 'doing', { today, actor: 'lamartio' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issue.frontmatter.assignee).toBe('lamartio');
    expect(getSection(result.issue.body, 'Log')).toContain('2026-10-21: Moved from ready to doing.');
    expect(result.changes.find((change) => change.path.endsWith('000_board.md'))!.content).toContain('## Doing\n\n- [002 Ready one](./002_ready.md) @lamartio');
  });

  it('needs a reason to move back', () => {
    expect(moveIssue(board, config, { board: '', number: 2 }, 'idea', { today }).ok).toBe(false);
    expect(moveIssue(board, config, { board: '', number: 2 }, 'idea', { today, reason: 'Not refined' }).ok).toBe(true);
  });

  it('archives instead of deleting, from any lane', () => {
    const result = archiveIssue(board, config, { board: '', number: 1 }, { today, reason: 'Duplicate of 002' });
    expect(result.ok && result.issue.frontmatter.status).toBe('archived');
    expect(result.ok && getSection(result.issue.body, 'Log')).toContain('Archived: Duplicate of 002');
    expect(result.ok && result.changes.every((change) => change.content !== null)).toBe(true);
  });
});

describe('updating and searching', () => {
  const snap = snapshot({
    'docs/board/001_login.md': issueText({ title: 'Login', tags: '[auth]' }),
    'docs/board/002_old.md': issueText({ title: 'Old login idea', status: 'archived' }),
    'docs/board/ANT-TEST_001_home.md': issueText({ title: 'Home' }),
  });
  const board = loadBoard(snap, config);

  it('fills a section and logs it; the Log stays append-only', () => {
    const result = updateIssue(board, config, { board: '', number: 1 }, { sections: { 'Done when': '- [ ] Users can sign in' } }, today);
    expect(result.ok && getSection(result.issue.body, 'Done when')).toBe('- [ ] Users can sign in');
    expect(updateIssue(board, config, { board: '', number: 1 }, { sections: { Log: 'x' } }, today).ok).toBe(false);
  });

  it('adds comments to the Log', () => {
    const result = addComment(board, config, { board: '', number: 1 }, 'Looks good', today, 'danny');
    expect(result.ok && getSection(result.issue.body, 'Log')).toContain('@danny: Looks good');
  });

  it('searches across boards and hides archived issues by default', () => {
    expect(searchIssues(board, config, { text: 'login' }).map((issue) => issue.number)).toEqual([1]);
    expect(searchIssues(board, config, { text: 'login', includeArchived: true })).toHaveLength(2);
    expect(searchIssues(board, config, { board: 'ANT-TEST' }).map((issue) => issue.frontmatter.title)).toEqual(['Home']);
    expect(searchIssues(board, config, { tag: 'auth' })).toHaveLength(1);
  });
});

describe('doctor', () => {
  it('regenerates boards, fixes unknown lanes and proposes renumbering duplicates', () => {
    const snap = snapshot({
      'docs/board/001_a.md': issueText({ title: 'A', created: '2026-01-01' }),
      'docs/board/001_b.md': issueText({ title: 'B', created: '2026-02-01' }),
      'docs/board/002_c.md': issueText({ title: 'C', status: 'wip' }),
      'docs/board/notes.md': 'hello',
    });
    const board = loadBoard(snap, config);
    const first = runDoctor(snap, board, config, { today });
    expect(first.numbersNeeded.get('')).toBe(1);
    expect(first.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['invalid-file', 'duplicate-number', 'unknown-lane', 'board-out-of-sync']),
    );
    const second = runDoctor(snap, board, config, { today, numbers: new Map([['', [3]]]) });
    expect(second.proposed.map((change) => [change.path, change.content === null])).toEqual([
      ['docs/board/001_b.md', true],
      ['docs/board/003_b.md', false],
      ['docs/board/000_board.md', false],
    ]);
    expect(second.proposed[2]!.content).toContain('[003 B](./003_b.md)');
    expect(second.safe.find((change) => change.path === 'docs/board/002_c.md')?.content).toContain('status: idea');
  });

  it('reports a dispenser behind the repo and a leftover board file', () => {
    const snap = snapshot({
      'docs/board/ANT-TEST/005_x.md': issueText({ title: 'X' }),
      'docs/board/ANT-TEST_000_board.md': '# old',
    });
    const report = runDoctor(snap, loadBoard(snap, config), config, { today, dispenserNext: new Map([['ANT-TEST', 3]]) });
    expect(report.problems.map((problem) => problem.code)).toEqual(expect.arrayContaining(['dispenser-behind', 'extra-board-file']));
    expect(report.safe).toContainEqual({ path: 'docs/board/ANT-TEST_000_board.md', content: null });
    expect(report.safe.some((change) => change.path === 'docs/board/ANT-TEST/000_board.md')).toBe(true);
  });

  it('finds nothing to do on a healthy board', () => {
    const created = createIssue(loadBoard(snapshot({}), config), config, 1, { title: 'A', why: 'B' }, { today });
    if (!created.ok) throw new Error(created.error);
    const snap = apply(snapshot({}), created.changes);
    const report = runDoctor(snap, loadBoard(snap, config), config, { today, hasConfigFile: true });
    expect(report.problems).toEqual([]);
    expect(report.safe).toEqual([]);
  });
});
