/**
 * Git-based publishing: any client (your computer, a Claude Code container) can build and deploy
 * a version tag, and git decides who does it. See packages/core/src/publish.ts for the model:
 * one branch of event commits, written only with fast-forward pushes.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventKind, type PublishConfig, type PublishEvent, type TagStatus, parseEnvFile, parseEvent, publishStatuses, resolvePublishEnv } from '@kanbai/core';

export type { PublishEvent, TagStatus } from '@kanbai/core';

/** Where the remote branch is kept locally: a private ref, so it never shows up as a local branch. */
const TRACKING = 'refs/kanbai/publish';
const RECORD_SEP = '\u001e';

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

  /** Fetches tags and the publish branch. Local tags are never pruned. Returns the branch head, if any. */
  sync(branch: string): string | undefined {
    this.run(['fetch', '--quiet', '--tags', this.remote]);
    const fetched = this.tryRun(['fetch', '--quiet', this.remote, `+refs/heads/${branch}:${TRACKING}`]);
    if (!fetched.ok) {
      // No such branch on the remote yet: forget any local copy.
      this.tryRun(['update-ref', '-d', TRACKING]);
      return undefined;
    }
    return this.head();
  }

  head(): string | undefined {
    const result = this.tryRun(['rev-parse', '--verify', '--quiet', TRACKING]);
    return result.ok ? result.out : undefined;
  }

  identity(): { by: string; host: string } {
    const name = this.tryRun(['config', 'user.name']);
    const email = this.tryRun(['config', 'user.email']);
    const by = name.ok && name.out ? (email.ok && email.out ? `${name.out} <${email.out}>` : name.out) : process.env.USER || 'unknown';
    return { by, host: process.env.KANBAI_HOST || hostname() };
  }

  /** Events on the publish branch, oldest first (up to the last 1000). */
  events(): PublishEvent[] {
    if (!this.head()) return [];
    const out = this.run(['log', '--max-count=1000', '--reverse', `--format=%B${RECORD_SEP}`, TRACKING]);
    return out
      .split(RECORD_SEP)
      .map((message) => parseEvent(message.trim()))
      .filter((event): event is PublishEvent => !!event);
  }

  /** Version tags matching the pattern, with the commit each points at. */
  versionTags(pattern: string): { tag: string; commit: string }[] {
    const out = this.run(['tag', '--list', pattern, '--format=%(refname:short) %(*objectname)%(objectname)']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [tag, shas] = line.split(' ');
        // Annotated tags print the peeled commit first; lightweight tags only their own object.
        return { tag: tag!, commit: shas!.slice(0, 40) };
      });
  }

  /**
   * Writes one event as a commit on top of `parent` and pushes it as a fast-forward.
   * Returns false when the branch moved on the remote meanwhile (someone else wrote first).
   */
  append(branch: string, parent: string | undefined, event: PublishEvent): boolean {
    const tree = this.run(['mktree'], '');
    const args = ['-c', 'user.name=kanbai', '-c', 'user.email=kanbai@localhost', 'commit-tree', tree, '-m', JSON.stringify(event)];
    if (parent) args.push('-p', parent);
    const commit = this.run(args);
    const pushed = this.tryRun(['push', '--quiet', '--porcelain', this.remote, `${commit}:refs/heads/${branch}`]);
    if (!pushed.ok) return false;
    this.run(['update-ref', TRACKING, commit]);
    return true;
  }
}

export function tagStatuses(git: Git, config: PublishConfig, now = new Date()): TagStatus[] {
  return publishStatuses(git.versionTags(config.tags), git.events(), now);
}

export interface PublishOptions {
  tag?: string;
  /** Publish a tag whose last attempt failed. */
  retry?: boolean;
  /** Show what would happen without claiming. */
  dryRun?: boolean;
  log: (line: string) => void;
  /** Renewal interval; defaults to a third of the lease. */
  heartbeatMs?: number;
}

export type PublishResult =
  | { outcome: 'done'; tag: string; durationMs: number }
  | { outcome: 'failed'; tag: string; exitCode: number }
  | { outcome: 'nothing'; reason: string }
  | { outcome: 'busy'; tag: string; by: string; host: string }
  | { outcome: 'dry-run'; tag: string };

const tail = (text: string, lines = 40) => text.split('\n').slice(-lines).join('\n').slice(-4000);

type Decision = { go: true; status: TagStatus } | { go: false; result: PublishResult };

/**
 * Which tag to build:
 * - No tag given: the newest tag, and only while nobody has claimed or published it. When it is
 *   claimed or already published, name a version explicitly. A failed newest tag needs --retry.
 * - A tag given: that tag in any state (redeploy, rollback, retry), unless someone is building it.
 */
function decide(statuses: TagStatus[], config: PublishConfig, tag: string | undefined, retry: boolean | undefined): Decision {
  const status = tag ? statuses.find((entry) => entry.tag === tag) : statuses[0];
  if (!status) {
    return {
      go: false,
      result: {
        outcome: 'nothing',
        reason: tag ? `Tag ${tag} doesn't exist (or doesn't match "${config.tags}").` : `No tags match "${config.tags}". Create one first, e.g. git tag v0.1.0 && git push --tags.`,
      },
    };
  }
  if (status.state === 'building') return { go: false, result: { outcome: 'busy', tag: status.tag, by: status.lock!.by, host: status.lock!.host } };
  if (tag) return { go: true, status };
  if (status.state === 'done') {
    return {
      go: false,
      result: { outcome: 'nothing', reason: `The newest tag, ${status.tag}, is already published (by ${status.done!.by} on ${status.done!.host}, ${status.done!.at}). To deploy a version anyway, name it: publish <tag>.` },
    };
  }
  if (status.state === 'failed' && !retry) {
    return { go: false, result: { outcome: 'nothing', reason: `The newest tag, ${status.tag}, failed last time (exit ${status.failed!.exitCode}, on ${status.failed!.host}). Fix it with a new tag, or run again with --retry.` } };
  }
  return { go: true, status };
}

/** Writes an event, re-reading and retrying when another client wrote first. `check` may veto a retry. */
function appendWithRetry(git: Git, config: PublishConfig, makeEvent: () => PublishEvent, check?: () => string | undefined): { ok: true } | { ok: false; reason: string } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const head = attempt === 0 ? git.head() : git.sync(config.branch);
    const veto = attempt === 0 ? undefined : check?.();
    if (veto) return { ok: false, reason: veto };
    if (git.append(config.branch, head, makeEvent())) return { ok: true };
  }
  return { ok: false, reason: 'The publish branch kept changing; try again.' };
}

/**
 * The command's environment: this client's environment, plus the untracked env file, with
 * `publish.env` on top (`${NAME}` filled in). Refuses an env file that git tracks, so secrets
 * never get committed by accident.
 */
export function publishEnvironment(git: Git, config: PublishConfig): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  const file = join(git.cwd, ...config.envFile.split('/'));
  let fromFile: Record<string, string> = {};
  if (existsSync(file)) {
    if (git.tryRun(['ls-files', '--error-unmatch', config.envFile]).ok) {
      return { ok: false, reason: `${config.envFile} is tracked by git, so its secrets are in the repo history. Remove it from git (git rm --cached ${config.envFile}), add it to .gitignore, and rotate the secrets in it.` };
    }
    fromFile = parseEnvFile(readFileSync(file, 'utf8'));
  }
  // This machine's real environment wins over the file.
  const source: Record<string, string | undefined> = { ...fromFile, ...process.env };
  const resolved = resolvePublishEnv(config.env, source);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `This client can't deploy: ${resolved.missing.join(', ')} ${resolved.missing.length > 1 ? 'are' : 'is'} not set. Set ${resolved.missing.length > 1 ? 'them' : 'it'} in this machine's environment (in a Claude Code container: its environment secrets), or in ${config.envFile}. Nothing was claimed.`,
    };
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined) env[name] = value;
  return { ok: true, env: { ...env, ...resolved.env } };
}

/** Picks the tag, claims it, runs the command in a clean checkout, and records the outcome. */
export async function publish(git: Git, config: PublishConfig, options: PublishOptions): Promise<PublishResult> {
  git.sync(config.branch);
  const environment = publishEnvironment(git, config);
  if (!environment.ok) return { outcome: 'nothing', reason: environment.reason };
  const first = decide(tagStatuses(git, config), config, options.tag, options.retry);
  if (!first.go) return first.result;
  if (options.dryRun) return { outcome: 'dry-run', tag: first.status.tag };

  const { tag, commit } = first.status;
  const me = git.identity();
  const claim = randomUUID();
  const leaseMs = config.leaseMinutes * 60_000;
  const started = new Date();
  const event = (kind: EventKind, extra: Partial<PublishEvent> = {}): PublishEvent => ({
    kind,
    tag,
    commit,
    claim,
    ...me,
    at: new Date().toISOString(),
    ...(kind === 'claim' || kind === 'renew' ? { expires: new Date(Date.now() + leaseMs).toISOString() } : {}),
    ...extra,
  });
  const tookOver = first.status.state === 'stale';

  // Claim. When another write lands first, look again: maybe that write was someone claiming this tag.
  let busy: PublishResult | undefined;
  const claimed = appendWithRetry(git, config, () => event('claim'), () => {
    // Someone wrote first. If they claimed this tag, stop; if they published it, stop too unless a version was named.
    const again = decide(tagStatuses(git, config), config, options.tag, options.retry);
    if (again.go && again.status.tag !== tag) {
      busy = { outcome: 'nothing', reason: `A newer tag, ${again.status.tag}, appeared while claiming ${tag}. Run publish again.` };
      return 'changed';
    }
    if (!again.go) {
      busy = again.result;
      return 'taken';
    }
    return undefined;
  });
  if (!claimed.ok) return busy ?? { outcome: 'nothing', reason: claimed.reason };
  options.log(`Claimed ${tag} (${commit.slice(0, 7)}) as ${me.by} on ${me.host}.${tookOver ? ' Took over an expired claim.' : ''}`);

  // Renew the claim while the build runs.
  const stillMine = () => (tagStatuses(git, config).find((status) => status.tag === tag)?.lock?.claim === claim ? undefined : 'Lost the claim.');
  let lost = false;
  const heartbeat = setInterval(() => {
    const renewed = appendWithRetry(git, config, () => event('renew'), stillMine);
    if (!renewed.ok) lost = true;
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
        env: { ...environment.env, KANBAI_TAG: tag, KANBAI_COMMIT: commit },
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

  const durationMs = Date.now() - started.getTime();
  const outcome = event(exitCode === 0 ? 'done' : 'failed', { started: started.toISOString(), durationMs, exitCode, log: tail(output) });
  // The outcome is recorded even if the claim was lost meanwhile: it describes what this client deployed.
  const recorded = appendWithRetry(git, config, () => ({ ...outcome, at: new Date().toISOString() }));
  if (lost) options.log('Warning: the claim expired during the build, so another client may have started too.');
  if (!recorded.ok) options.log(`Warning: couldn't record the outcome: ${recorded.reason}`);
  return exitCode === 0 ? { outcome: 'done', tag, durationMs } : { outcome: 'failed', tag, exitCode };
}

/** Drops a claim by hand, e.g. after killing a build. */
export function releaseLock(git: Git, config: PublishConfig, tag: string): boolean {
  git.sync(config.branch);
  const lock = tagStatuses(git, config).find((status) => status.tag === tag)?.lock;
  if (!lock) return false;
  const me = git.identity();
  return appendWithRetry(git, config, () => ({ kind: 'release', tag, commit: lock.commit, claim: lock.claim, ...me, at: new Date().toISOString() })).ok;
}
