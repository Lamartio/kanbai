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

const config = (command: string, leaseMinutes = 30): PublishConfig => ({ command, tags: 'v*', leaseMinutes });

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
    b.sync();
    expect(tagStatuses(b, config('x'))[0]).toMatchObject({ tag: 'v0.1.0', state: 'done', done: { by: 'alice <alice@example.com>' } });
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
    b.sync();
    expect(tagStatuses(b, config('x'))[0]!.state).toBe('failed');
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'nothing' });
    expect(await publish(b, config('true'), { log: quiet, retry: true })).toMatchObject({ outcome: 'done' });
    a.sync();
    const status = tagStatuses(a, config('x'))[0]!;
    expect(status.state).toBe('done');
    expect(status.failed).toBeUndefined();
  });

  it('takes over a claim whose lease ran out', async () => {
    const stale = a.markerCommit({ tag: 'v0.1.0', commit: 'x', by: 'ghost', host: 'gone', at: '2026-01-01T00:00:00Z', expires: '2026-01-01T00:30:00Z' });
    expect(a.push([`${stale}:refs/kanbai/lock/v0.1.0`]).ok).toBe(true);
    b.sync();
    expect(tagStatuses(b, config('x'))[0]!.state).toBe('stale');
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'done' });
  });

  it('reports a live claim as busy, and can drop it by hand', async () => {
    const live = a.markerCommit({ tag: 'v0.1.0', commit: 'x', by: 'alice', host: 'laptop', at: new Date().toISOString(), expires: new Date(Date.now() + 600_000).toISOString() });
    a.push([`${live}:refs/kanbai/lock/v0.1.0`]);
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'busy', by: 'alice', host: 'laptop' });
    expect(releaseLock(b, 'v0.1.0')).toBe(true);
    expect(await publish(b, config('true'), { log: quiet })).toMatchObject({ outcome: 'done' });
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
    expect(existsSync(join(b.cwd, '.git'))).toBe(true);
  });
});
