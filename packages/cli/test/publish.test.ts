import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from '@kanbai/core';
import { Git, publish, releaseLock, tagStatuses } from '../src/publish.js';

let base: string;
let a: Git;
let b: Git;
const quiet = () => {};

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function clone(name: string): Git {
  const dir = join(base, name);
  git(base, 'clone', '--quiet', join(base, 'origin.git'), dir);
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name}@example.com`);
  return new Git(dir);
}

const config = (command: string, leaseMinutes = 30, env: Record<string, string> = {}): PublishConfig => ({ command, tags: 'v*', leaseMinutes, branch: 'kanbai/publish', env, envFile: '.env.publish' });
const BRANCH = 'kanbai/publish';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kanbai-publish-test-'));
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', 'origin.git');
  const seed = join(base, 'seed');
  git(base, 'clone', '--quiet', join(base, 'origin.git'), seed);
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  writeFileSync(join(seed, 'app.txt'), 'v1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'first');
  git(seed, 'tag', '-a', 'v0.1.0', '-m', 'first release');
  git(seed, 'push', '--quiet', 'origin', 'main', '--tags');
  a = clone('alice');
  b = clone('bob');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('git-based publish', () => {
  it('builds the newest tag in a clean checkout and marks it done', async () => {
    const out = join(base, 'built.txt');
    const result = await publish(a, config(`cat app.txt > "${out}" && echo "$KANBAI_TAG" >> "${out}"`), { log: quiet });
    expect(result.outcome).toBe('done');
    expect(readFileSync(out, 'utf8')).toBe('v1\nv0.1.0\n');
    // Another client sees it as done and does nothing.
    const again = await publish(b, config('exit 1'), { log: quiet });
    expect(again).toMatchObject({ outcome: 'nothing' });
    b.sync(BRANCH);
    expect(tagStatuses(b, config('x'))[0]).toMatchObject({ tag: 'v0.1.0', state: 'done', done: { by: 'alice <alice@example.com>' } });
    // The branch is a readable deploy log, and nothing else was pushed.
    expect(git(b.cwd, 'ls-remote', 'origin').split('\n').map((line) => line.split('\t')[1]).sort()).toEqual(['HEAD', 'refs/heads/kanbai/publish', 'refs/heads/main', 'refs/tags/v0.1.0', 'refs/tags/v0.1.0^{}']);
    expect(git(a.cwd, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('lets exactly one of two racing clients build', async () => {
    const counter = join(base, 'count.txt');
    const command = `sleep 1 && echo x >> "${counter}"`;
    const results = await Promise.all([publish(a, config(command), { log: quiet }), publish(b, config(command), { log: quiet })]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(['busy', 'done']);
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
  });

  it('marks failures, needs --retry, and clears the failure once it works', async () => {
    expect(await publish(a, config('exit 3'), { log: quiet })).toMatchObject({ outcome: 'failed', exitCode: 3 });
    b.sync(BRANCH);
    expect(tagStatuses(b, config('x'))[0]!.state).toBe('failed');
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'nothing' });
    expect(await publish(b, config('true'), { log: quiet, retry: true })).toMatchObject({ outcome: 'done' });
    a.sync(BRANCH);
    const status = tagStatuses(a, config('x'))[0]!;
    expect(status.state).toBe('done');
    expect(status.failed).toBeUndefined();
  });

  it('takes over a claim whose lease ran out', async () => {
    a.sync(BRANCH);
    expect(a.append(BRANCH, a.head(), { kind: 'claim', tag: 'v0.1.0', commit: 'x', claim: 'ghost-claim', by: 'ghost', host: 'gone', at: '2026-01-01T00:00:00Z', expires: '2026-01-01T00:30:00Z' })).toBe(true);
    b.sync(BRANCH);
    expect(tagStatuses(b, config('x'))[0]!.state).toBe('stale');
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'done' });
  });

  it('reports a live claim as busy, and can drop it by hand', async () => {
    a.sync(BRANCH);
    a.append(BRANCH, a.head(), { kind: 'claim', tag: 'v0.1.0', commit: 'x', claim: 'alice-claim', by: 'alice', host: 'laptop', at: new Date().toISOString(), expires: new Date(Date.now() + 600_000).toISOString() });
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'busy', by: 'alice', host: 'laptop' });
    expect(releaseLock(b, config('true'), 'v0.1.0')).toBe(true);
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'done' });
  });

  it('rejects a write on a stale head: the fast-forward is the lock', () => {
    a.sync(BRANCH);
    b.sync(BRANCH);
    const event = { kind: 'claim' as const, tag: 'v0.1.0', commit: 'x', claim: 'c', by: 'x', host: 'y', at: '' };
    expect(a.append(BRANCH, a.head(), { ...event, claim: 'a' })).toBe(true);
    expect(b.append(BRANCH, b.head(), { ...event, claim: 'b' })).toBe(false);
  });

  it('keeps renewing a long build', async () => {
    const result = await publish(a, config('sleep 1'), { log: quiet, heartbeatMs: 200 });
    expect(result.outcome).toBe('done');
    const kinds = a.events().map((event) => event.kind);
    expect(kinds[0]).toBe('claim');
    expect(kinds.filter((kind) => kind === 'renew').length).toBeGreaterThanOrEqual(2);
    expect(kinds.at(-1)).toBe('done');
  });

  it('needs a version once the newest tag is published, and then redeploys it', async () => {
    expect(await publish(a, config('true'), { log: quiet })).toMatchObject({ outcome: 'done' });
    const plain = await publish(b, config('true'), { log: quiet });
    expect(plain).toMatchObject({ outcome: 'nothing' });
    expect(plain.outcome === 'nothing' && plain.reason).toContain('name it');
    expect(await publish(b, config('true'), { log: quiet, tag: 'v0.1.0' })).toMatchObject({ outcome: 'done', tag: 'v0.1.0' });
  });

  it('refuses a named version while someone builds it', async () => {
    a.sync(BRANCH);
    a.append(BRANCH, a.head(), { kind: 'claim', tag: 'v0.1.0', commit: 'x', claim: 'k', by: 'alice', host: 'laptop', at: new Date().toISOString(), expires: new Date(Date.now() + 600_000).toISOString() });
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'busy' });
    expect(await publish(b, config('true'), { log: quiet, tag: 'v0.1.0' })).toMatchObject({ outcome: 'busy' });
  });

  it('checks secret references before claiming anything', async () => {
    const result = await publish(a, config('true', 30, { TOKEN: '${KANBAI_TEST_SURELY_UNSET}' }), { log: quiet });
    expect(result.outcome === 'nothing' && result.reason).toContain('KANBAI_TEST_SURELY_UNSET is not set');
    a.sync(BRANCH);
    expect(a.events()).toEqual([]);
  });

  it('passes plain values and secrets from the untracked env file', async () => {
    writeFileSync(join(a.cwd, '.env.publish'), 'DEPLOY_TOKEN=s3cret\n');
    const out = join(base, 'env.txt');
    const result = await publish(a, config(`echo "$STAGE $TOKEN" > "${out}"`, 30, { STAGE: 'production', TOKEN: '${DEPLOY_TOKEN}' }), { log: quiet });
    expect(result.outcome).toBe('done');
    expect(readFileSync(out, 'utf8')).toBe('production s3cret\n');
    // The secret never ends up in the publish branch.
    expect(JSON.stringify(a.events())).not.toContain('s3cret');
  });

  it('masks secrets the script prints, on screen and in the recorded log', async () => {
    writeFileSync(join(a.cwd, '.env.publish'), 'DEPLOY_TOKEN=s3cret-value\n');
    const lines: string[] = [];
    const result = await publish(a, config('echo "using $TOKEN"; printf "partial s3cret-va"; printf "lue end\\n"; exit 1', 30, { TOKEN: '${DEPLOY_TOKEN}' }), { log: (line) => lines.push(line) });
    expect(result.outcome).toBe('failed');
    const output = lines.filter((line) => line.startsWith('  ')).join('\n');
    expect(output).not.toContain('s3cret');
    expect(output).toContain('using ***');
    const failed = a.events().find((event) => event.kind === 'failed')!;
    expect(failed.log).toContain('partial *** end');
    expect(failed.log).not.toContain('s3cret');
  });

  it('refuses an env file that git tracks', async () => {
    writeFileSync(join(a.cwd, '.env.publish'), 'DEPLOY_TOKEN=oops\n');
    git(a.cwd, 'add', '.env.publish');
    const result = await publish(a, config('true', 30, { TOKEN: '${DEPLOY_TOKEN}' }), { log: quiet });
    expect(result.outcome === 'nothing' && result.reason).toContain('tracked by git');
  });

  it('only builds the newest tag; older open tags are superseded', async () => {
    writeFileSync(join(a.cwd, 'app.txt'), 'v2\n');
    git(a.cwd, 'commit', '--quiet', '-am', 'second');
    git(a.cwd, 'tag', 'v0.2.0');
    git(a.cwd, 'push', '--quiet', 'origin', 'main', '--tags');
    const out = join(base, 'built.txt');
    expect(await publish(b, config(`cat app.txt > "${out}"`), { log: quiet })).toMatchObject({ outcome: 'done', tag: 'v0.2.0' });
    expect(readFileSync(out, 'utf8')).toBe('v2\n');
    expect(tagStatuses(b, config('x')).map((status) => [status.tag, status.state])).toEqual([
      ['v0.2.0', 'done'],
      ['v0.1.0', 'superseded'],
    ]);
    // Rolling back means naming the older version.
    expect(await publish(b, config(`cat app.txt > "${out}"`), { log: quiet, tag: 'v0.1.0' })).toMatchObject({ outcome: 'done', tag: 'v0.1.0' });
    expect(readFileSync(out, 'utf8')).toBe('v1\n');
    expect(existsSync(join(b.cwd, '.git'))).toBe(true);
  });
});
