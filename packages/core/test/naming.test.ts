import { describe, expect, it } from 'vitest';
import { classifyPath, formatId, newIssueRelativePath, parseId, slugify } from '../src/index.js';

describe('classifyPath', () => {
  it('reads main-board issues', () => {
    expect(classifyPath('001_build-login.md')).toEqual({ kind: 'issue', location: { board: '', number: 1, slug: 'build-login' } });
  });

  it('reads prefixed issues as their own board', () => {
    expect(classifyPath('ANT-TEST_001_create-home.md')).toEqual({ kind: 'issue', location: { board: 'ANT-TEST', number: 1, slug: 'create-home' } });
  });

  it('treats a kebab-case folder as a board, merging with prefixes', () => {
    expect(classifyPath('ANT-TEST/002_design.md')).toEqual({ kind: 'issue', location: { board: 'ANT-TEST', number: 2, slug: 'design' } });
  });

  it('keeps board names case-sensitive', () => {
    const upper = classifyPath('ANT-TEST/001_a.md');
    const lower = classifyPath('ant-test/001_a.md');
    expect(upper.kind === 'issue' && upper.location.board).toBe('ANT-TEST');
    expect(lower.kind === 'issue' && lower.location.board).toBe('ant-test');
  });

  it('reads sub-issues in an issue folder, with their parent', () => {
    expect(classifyPath('ANT-TEST/001_create-home/002_design.md')).toEqual({
      kind: 'issue',
      location: { board: 'ANT-TEST', number: 2, slug: 'design', parentPath: 'ANT-TEST/001_create-home.md' },
    });
    expect(classifyPath('ANT-TEST_001_create-home/003_copy.md')).toEqual({
      kind: 'issue',
      location: { board: 'ANT-TEST', number: 3, slug: 'copy', parentPath: 'ANT-TEST_001_create-home.md' },
    });
    expect(classifyPath('001_login/002_api/003_tokens.md')).toEqual({
      kind: 'issue',
      location: { board: '', number: 3, slug: 'tokens', parentPath: '001_login/002_api.md' },
    });
  });

  it('recognises board files', () => {
    expect(classifyPath('000_board.md')).toEqual({ kind: 'board-file', board: '' });
    expect(classifyPath('ANT-TEST_000_board.md')).toEqual({ kind: 'board-file', board: 'ANT-TEST' });
    expect(classifyPath('ANT-TEST/000_board.md')).toEqual({ kind: 'board-file', board: 'ANT-TEST' });
  });

  it('rejects names that break the rules', () => {
    expect(classifyPath('001-build-login.md').kind).toBe('invalid');
    expect(classifyPath('notes.md').kind).toBe('invalid');
    expect(classifyPath('ANT-TEST/OTHER_001_x.md').kind).toBe('invalid');
    expect(classifyPath('001_login/000_board.md').kind).toBe('invalid');
  });

  it('ignores non-markdown files such as attachments', () => {
    expect(classifyPath('attachments/012/screenshot.png').kind).toBe('other');
  });
});

describe('ids', () => {
  it('formats and parses', () => {
    expect(formatId('', 12)).toBe('012');
    expect(formatId('ANT-TEST', 3)).toBe('ANT-TEST_003');
    expect(parseId('12')).toEqual({ board: '', number: 12 });
    expect(parseId('ANT-TEST_003')).toEqual({ board: 'ANT-TEST', number: 3 });
    expect(parseId('ANT-TEST-003')).toEqual({ board: 'ANT-TEST', number: 3 });
    expect(parseId('nope')).toBeNull();
    expect(parseId('000')).toBeNull();
  });
});

describe('new paths', () => {
  it('places issues by board and parent', () => {
    expect(newIssueRelativePath({ board: '', number: 13, slug: 'dark-mode', boardHasFolder: false })).toBe('013_dark-mode.md');
    expect(newIssueRelativePath({ board: 'ANT-TEST', number: 4, slug: 'x', boardHasFolder: false })).toBe('ANT-TEST_004_x.md');
    expect(newIssueRelativePath({ board: 'ANT-TEST', number: 4, slug: 'x', boardHasFolder: true })).toBe('ANT-TEST/004_x.md');
    expect(newIssueRelativePath({ board: 'ANT-TEST', number: 5, slug: 'y', parentRelative: 'ANT-TEST/001_home.md', boardHasFolder: true })).toBe('ANT-TEST/001_home/005_y.md');
  });

  it('slugifies titles', () => {
    expect(slugify('Dark mode toggle!')).toBe('dark-mode-toggle');
    expect(slugify('Ação rápida')).toBe('acao-rapida');
    expect(slugify('???')).toBe('issue');
  });
});
