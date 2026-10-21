import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from '../src/tools.js';
import type { Env } from '../src/env.js';
import { FakeGitHub, fakeEnv, props } from './fakes.js';

let github: FakeGitHub;
let env: Env;
let id = 0;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError?: boolean }> {
  const handler = createMcpHandler(() => createServer(env, props), { route: '/mcp' });
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { repo: 'lamartio/test', ...args } } }),
  });
  const response = await handler(request, env as never, { waitUntil() {}, passThroughOnException() {}, props } as never);
  const raw = await response.text();
  const payload = raw.trim().startsWith('{') ? raw : raw.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
  const message = JSON.parse(payload) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (message.error) throw new Error(message.error.message);
  return { text: message.result!.content.map((part) => part.text).join('\n'), isError: message.result!.isError };
}

beforeEach(() => {
  github = new FakeGitHub();
  env = fakeEnv();
  vi.stubGlobal('fetch', github.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('tools against a fake GitHub', () => {
  it('sets up a board, files issues and moves them, one commit each', async () => {
    const init = await call('init_board');
    expect(init.isError).toBeFalsy();
    expect(github.files['.board.json']).toContain('"ARCHIVED"');
    expect(github.files['docs/board/000_board.md']).toContain('## TODO');

    const created = await call('create_issue', { title: 'Build login', why: 'Users need accounts.' });
    expect(created.text).toContain('Created 001 "Build login"');
    expect(created.text).toContain('Still missing');
    expect(github.files['docs/board/001_build-login.md']).toContain('title: Build login');
    expect(github.files['docs/board/000_board.md']).toContain('- [001 Build login](./001_build-login.md)');

    const blocked = await call('move_issue', { id: '001', lane: 'DOING' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('Done when is empty');

    await call('update_issue', { id: '1', sections: { done_when: '- [ ] Signing in with GitHub works' } });
    const moved = await call('move_issue', { id: '001', lane: 'DOING' });
    expect(moved.isError).toBeFalsy();
    expect(github.files['docs/board/001_build-login.md']).toContain('status: DOING');
    expect(github.commits.map((commit) => commit.headline)).toEqual([
      'kanbai: set up the board',
      'kanbai: create 001 Build login',
      'kanbai: update 001 Build login',
      'kanbai: move 001 to DOING',
    ]);
  });

  it('keeps numbers atomic per board, also across a hand-made file', async () => {
    await call('init_board');
    await call('create_issue', { title: 'A', why: 'x' });
    // Someone pushes 005 by hand on the main board.
    github.push({ 'docs/board/005_manual.md': '---\ntitle: Manual\ntype: feature\nstatus: TODO\ncreated: 2026-10-21\n---\n\n## Why\n\nx\n' });
    const next = await call('create_issue', { title: 'B', why: 'y' });
    expect(next.text).toContain('Created 006');
    const other = await call('create_issue', { title: 'Create home', why: 'z', board: 'ANT-TEST' });
    expect(other.text).toContain('Created ANT-TEST_001');
    expect(github.files['docs/board/ANT-TEST_000_board.md']).toContain('ANT-TEST_001 Create home');
    const reserved = await call('reserve_numbers', { board: 'ANT-TEST', count: 3 });
    expect(reserved.text).toContain('ANT-TEST_002, ANT-TEST_003, ANT-TEST_004');
  });

  it('files a feature with sub-issues in one commit', async () => {
    await call('init_board');
    const result = await call('create_issues', {
      issues: [
        { title: 'Create home', why: 'Landing.', board: 'ANT-TEST' },
        { title: 'Design', why: 'Look.', parent_index: 0 },
        { title: 'Copy', why: 'Words.', parent_index: 0 },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(Object.keys(github.files).filter((path) => path.includes('ANT-TEST')).sort()).toEqual([
      'docs/board/ANT-TEST_000_board.md',
      'docs/board/ANT-TEST_001_create-home.md',
      'docs/board/ANT-TEST_001_create-home/002_design.md',
      'docs/board/ANT-TEST_001_create-home/003_copy.md',
    ]);
    expect(github.files['docs/board/ANT-TEST_000_board.md']).not.toContain('Design');
    const pack = await call('context_pack', { id: 'ANT-TEST_001' });
    expect(pack.text).toContain('## Sub-issues');
    expect(pack.text).toContain('ANT-TEST_002');
  });

  it('retries when someone pushes between reading and committing', async () => {
    await call('init_board');
    const original = github.fetch;
    let pushed = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!pushed && String(init?.body ?? '').includes('createCommitOnBranch')) {
        pushed = true;
        github.push({ 'docs/notes.md': '# Notes\n' });
      }
      return original(input, init);
    });
    const created = await call('create_issue', { title: 'Raced', why: 'Concurrency.' });
    expect(created.isError).toBeFalsy();
    expect(github.files['docs/notes.md']).toBe('# Notes\n');
    expect(github.files['docs/board/001_raced.md']).toBeDefined();
  });

  it('archives instead of deleting, and hides archived issues from search', async () => {
    await call('init_board');
    await call('create_issue', { title: 'Old idea', why: 'x' });
    await call('archive_issue', { id: '001', reason: 'No longer needed' });
    expect(github.files['docs/board/001_old-idea.md']).toContain('status: ARCHIVED');
    expect((await call('search_issues', { text: 'old' })).text).toBe('No issues match.');
    expect((await call('search_issues', { text: 'old', include_archived: true })).text).toContain('001');
  });

  it('runs the doctor: reports, then fixes', async () => {
    github.push({
      'docs/board/001_a.md': '---\ntitle: A\ntype: feature\nstatus: TODO\ncreated: 2026-01-01\n---\n\n## Why\n\nx\n',
      'docs/board/001_b.md': '---\ntitle: B\ntype: feature\nstatus: wip\ncreated: 2026-02-01\n---\n\n## Why\n\ny\n',
    });
    const report = await call('doctor');
    expect(report.text).toContain('used twice');
    expect(report.text).toContain('unknown lane');
    expect(github.commits).toHaveLength(0);
    await call('doctor', { apply: 'all' });
    expect(github.files['docs/board/001_b.md']).toBeUndefined();
    expect(github.files['docs/board/002_b.md']).toContain('status: TODO');
    expect(github.files['docs/board/000_board.md']).toContain('002 B');
    expect(github.files['.board.json']).toBeDefined();
    expect((await call('doctor')).text).toContain('healthy');
  });

  it('changes the lanes and moves issues along', async () => {
    await call('init_board');
    await call('create_issue', { title: 'A', why: 'x' });
    const result = await call('set_lanes', { lanes: ['BACKLOG', 'DOING', 'REVIEW', 'DONE'], rename: { TODO: 'BACKLOG' } });
    expect(result.text).toContain('BACKLOG → DOING → REVIEW → DONE → ARCHIVED');
    expect(github.files['docs/board/001_a.md']).toContain('status: BACKLOG');
    expect(github.files['docs/board/000_board.md']).toContain('## REVIEW');
  });

  it('shows publish states per tag', async () => {
    github.push({ '.board.json': JSON.stringify({ publish: { command: 'npm run deploy' } }) });
    github.tags = ['v1.0.0', 'v1.1.0'];
    const base = { tag: 'v1.1.0', commit: 'x', claim: 'k', by: 'danny', host: 'ipad-container' };
    github.events = [
      JSON.stringify({ ...base, kind: 'claim', at: '2026-10-21T10:00:00Z', expires: '2026-10-21T10:30:00Z' }),
      JSON.stringify({ ...base, kind: 'failed', at: '2026-10-21T10:02:00Z', exitCode: 2, log: 'Error: missing token' }),
    ];
    const result = await call('publish_status');
    expect(result.text).toContain('v1.1.0 failed — danny on ipad-container');
    expect(result.text).toContain('Error: missing token');
    expect(result.text).toContain('v1.0.0 superseded');
  });

  it('tags a release after a preview', async () => {
    github.tags = ['v1.9.0', 'v1.10.0'];
    const preview = await call('tag_release', { bump: 'minor' });
    expect(preview.text).toContain('Preview: tag v1.11.0');
    expect(github.createdTags).toHaveLength(0);
    const created = await call('tag_release', { bump: 'minor', confirm: true });
    expect(created.text).toContain('Created tag v1.11.0');
    expect(github.createdTags).toEqual([{ ref: 'refs/tags/v1.11.0', sha: github.head }]);
    expect((await call('tag_release', { tag: 'v1.11.0', confirm: true })).text).toContain('already exists');
  });

  it('explains a missing repo instead of crashing', async () => {
    const handler = await call('get_board', { repo: 'not a repo' });
    expect(handler.isError).toBe(true);
    expect(handler.text).toContain("isn't a repo");
  });
});
