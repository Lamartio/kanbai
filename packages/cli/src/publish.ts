/**
 * Git-based publishing: any client (your computer, a Claude Code container) can build and deploy a
 * version tag, and git decides who does it.
 *
 *   refs/kanbai/lock/<tag>     claimed: someone is building it right now
 *   refs/kanbai/done/<tag>     built and deployed
 *   refs/kanbai/failed/<tag>   the last attempt failed
 *
 * Each ref points at a tiny commit whose message is JSON (who, where, when, result).
 * Claiming is a push that creates the lock ref. The remote refuses to create a ref that already
 * exists, so when two clients claim the same tag at once, exactly one push succeeds. Taking over an
 * expired lock uses --force-with-lease, which only replaces the lock if it is still the old one.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Marker, type PublishConfig, type TagStatus, parseMarker, publishStatuses } from '@kanbai/core';

export type { Marker, TagStatus } from '@kanbai/core';

const NS = 'refs/kanbai';
const EMPTY_TREE_INPUT = '';

export class Git {
  constructor(
    readonly cwd: string,
    readonly remote = 'origin',
  ) {}

  run(args: string[], input?: string): string {
    return execFileSync('git', args, { cwd: this.cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  tryRun(args: string[], input?: string): { ok: true; out: string } | { ok: false; err: string } {
    try {
      return { ok: true, out: this.run(args, input) };
    } catch (error) {
      const failure = error as { stderr?: string; message: string };
      return { ok: false, err: (failure.stderr || failure.message).trim() };
    }
  }

  /** Brings kanbai refs (pruning ones deleted on the remote) and tags up to date. Local tags are never pruned. */
  sync(): void {
    this.run(['fetch', '--quiet', '--prune', this.remote, `+${NS}/*:${NS}/*`]);
    this.run(['fetch', '--quiet', '--tags', this.remote]);
  }

  identity(): { by: string; host: string } {
    const name = this.tryRun(['config', 'user.name']);
    const email = this.tryRun(['config', 'user.email']);
    const by = name.ok && name.out ? (email.ok && email.out ? `${name.out} <${email.out}>` : name.out) : process.env.USER || 'unknown';
    return { by, host: process.env.KANBAI_HOST || hostname() };
  }

  /** A commit with an empty tree whose message is the marker, so it can live in any ref. */
  markerCommit(marker: Marker): string {
    const tree = this.run(['mktree'], EMPTY_TREE_INPUT);
    return this.run(['-c', 'user.name=kanbai', '-c', 'user.email=kanbai@localhost', 'commit-tree', tree, '-m', JSON.stringify(marker)]);
  }

  readMarker(ref: string): Marker | undefined {
    const message = this.tryRun(['log', '-1', '--format=%B', ref]);
    return message.ok ? parseMarker(message.out) : undefined;
  }

  refSha(ref: string): string | undefined {
    const result = this.tryRun(['rev-parse', '--verify', '--quiet', ref]);
    return result.ok ? result.out : undefined;
  }

  /** Version tags matching the pattern, newest first, with the commit each points at. */
  versionTags(pattern: string): { tag: string; commit: string }[] {
    const out = this.run(['tag', '--list', pattern, '--sort=-v:refname', '--format=%(refname:short) %(*objectname)%(objectname)']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [tag, shas] = line.split(' ');
        // Annotated tags print the peeled commit first; lightweight tags only their own object.
        return { tag: tag!, commit: shas!.slice(0, 40) };
      });
  }

  push(args: string[]): { ok: true } | { ok: false; err: string } {
    const result = this.tryRun(['push', '--quiet', '--porcelain', this.remote, ...args]);
    return result.ok ? { ok: true } : result;
  }
}

const lockRef = (tag: string) => `${NS}/lock/${tag}`;
const doneRef = (tag: string) => `${NS}/done/${tag}`;
const failedRef = (tag: string) => `${NS}/failed/${tag}`;

export function tagStatuses(git: Git, config: PublishConfig, now = new Date()): TagStatus[] {
  const tags = git.versionTags(config.tags);
  const markers = new Map(tags.map(({ tag }) => [tag, { lock: git.readMarker(lockRef(tag)), done: git.readMarker(doneRef(tag)), failed: git.readMarker(failedRef(tag)) }]));
  return publishStatuses(tags, markers, now);
}

export interface PublishOptions {
  tag?: string;
  /** Publish a tag whose last attempt failed. */
  retry?: boolean;
  /** Show what would happen without claiming. */
  dryRun?: boolean;
  log: (line: string) => void;
  /** Heartbeat interval; defaults to a third of the lease. */
  heartbeatMs?: number;
}

export type PublishResult =
  | { outcome: 'done'; tag: string; durationMs: number }
  | { outcome: 'failed'; tag: string; exitCode: number }
  | { outcome: 'nothing'; reason: string }
  | { outcome: 'busy'; tag: string; by: string; host: string }
  | { outcome: 'dry-run'; tag: string };

function tail(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n').slice(-4000);
}

/** Picks the tag, claims it, runs the command in a clean checkout, and records the outcome. */
export async function publish(git: Git, config: PublishConfig, options: PublishOptions): Promise<PublishResult> {
  git.sync();
  const statuses = tagStatuses(git, config);
  let target: TagStatus | undefined;
  if (options.tag) {
    target = statuses.find((status) => status.tag === options.tag);
    if (!target) return { outcome: 'nothing', reason: `Tag ${options.tag} doesn't exist (or doesn't match "${config.tags}").` };
  } else {
    target = statuses[0];
    if (!target) return { outcome: 'nothing', reason: `No tags match "${config.tags}". Create one first, e.g. git tag v0.1.0 && git push --tags.` };
  }
  if (target.state === 'done') return { outcome: 'nothing', reason: `${target.tag} is already published (by ${target.done!.by} on ${target.done!.host}, ${target.done!.finished}).` };
  if (target.state === 'building') return { outcome: 'busy', tag: target.tag, by: target.lock!.by, host: target.lock!.host };
  if (target.state === 'failed' && !options.retry) {
    return { outcome: 'nothing', reason: `${target.tag} failed last time (exit ${target.failed!.exitCode}, ${target.failed!.host}). Fix it with a new tag, or run again with --retry.` };
  }
  if (options.dryRun) return { outcome: 'dry-run', tag: target.tag };

  const { tag, commit } = target;
  const me = git.identity();
  const leaseMs = config.leaseMinutes * 60_000;
  const started = new Date();
  const lockMarker = (): Marker => ({ tag, commit, ...me, at: started.toISOString(), expires: new Date(Date.now() + leaseMs).toISOString() });

  // Claim: create the lock ref, or replace a stale one only if it is still the same stale one.
  let lockSha = git.markerCommit(lockMarker());
  const staleSha = target.state === 'stale' ? git.refSha(lockRef(tag)) : undefined;
  const claim = staleSha
    ? git.push([`--force-with-lease=${lockRef(tag)}:${staleSha}`, `${lockSha}:${lockRef(tag)}`])
    : git.push([`${lockSha}:${lockRef(tag)}`]);
  if (!claim.ok) {
    git.sync();
    const lock = git.readMarker(lockRef(tag));
    return { outcome: 'busy', tag, by: lock?.by ?? 'someone', host: lock?.host ?? 'another client' };
  }
  options.log(`Claimed ${tag} (${commit.slice(0, 7)}) as ${me.by} on ${me.host}.${staleSha ? ' Took over an expired claim.' : ''}`);

  // Heartbeat: extend the claim while the build runs.
  let lost = false;
  const heartbeat = setInterval(() => {
    const next = git.markerCommit(lockMarker());
    const result = git.push([`--force-with-lease=${lockRef(tag)}:${lockSha}`, `${next}:${lockRef(tag)}`]);
    if (result.ok) lockSha = next;
    else lost = true;
  }, options.heartbeatMs ?? Math.max(1000, leaseMs / 3));

  // Build in a separate, clean checkout, so the working copy (and other agents in it) stay untouched.
  const dir = mkdtempSync(join(tmpdir(), `kanbai-publish-${tag.replace(/[^\w.-]/g, '_')}-`));
  let output = '';
  let exitCode = 1;
  try {
    git.run(['worktree', 'add', '--detach', '--quiet', dir, commit]);
    options.log(`Running "${config.command}" in a clean checkout of ${tag}…`);
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(config.command, {
        cwd: dir,
        shell: true,
        env: { ...process.env, KANBAI_TAG: tag, KANBAI_COMMIT: commit },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        for (const line of text.split('\n')) if (line) options.log(`  ${line}`);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (error) => {
        output += String(error);
        resolve(127);
      });
    });
  } finally {
    clearInterval(heartbeat);
    git.tryRun(['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }

  const finished = new Date();
  const durationMs = finished.getTime() - started.getTime();
  const result: Marker = { tag, commit, ...me, at: started.toISOString(), finished: finished.toISOString(), durationMs, exitCode, log: tail(output) };
  const markerSha = git.markerCommit(result);
  const outcomeRef = exitCode === 0 ? doneRef(tag) : failedRef(tag);
  // One atomic push: record the outcome and release the lock together (only if the lock is still ours).
  const release = git.push(['--atomic', `--force-with-lease=${lockRef(tag)}:${lockSha}`, `+${markerSha}:${outcomeRef}`, `:${lockRef(tag)}`]);
  if (!release.ok) {
    options.log(`Warning: couldn't record the outcome cleanly${lost ? ' (the claim was lost during the build)' : ''}: ${release.err}`);
    git.push([`+${markerSha}:${outcomeRef}`]);
  }
  if (exitCode === 0) git.tryRun(['push', '--quiet', git.remote, '--delete', failedRef(tag)]);
  git.sync();
  return exitCode === 0 ? { outcome: 'done', tag, durationMs } : { outcome: 'failed', tag, exitCode };
}

/** Removes a claim by hand, e.g. after killing a build. */
export function releaseLock(git: Git, tag: string): boolean {
  git.sync();
  const sha = git.refSha(lockRef(tag));
  if (!sha) return false;
  return git.push([`--force-with-lease=${lockRef(tag)}:${sha}`, `:${lockRef(tag)}`]).ok;
}
