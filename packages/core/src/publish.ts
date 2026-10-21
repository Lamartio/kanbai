/**
 * Shared rules for git-based publishing. The CLI does the git work, the MCP only reads.
 *
 * Everything lives on one branch, `kanbai/publish` by default. Each commit on it is one event,
 * with an empty tree and a JSON message: a claim, a renewal, done, failed or a manual release.
 * Every write is a plain fast-forward push of one new commit on top of the branch, so:
 *   - when two clients write at the same moment, the remote accepts one and rejects the other
 *     (non-fast-forward): that is the lock;
 *   - nothing is ever force-pushed or deleted, which also works through restrictive git proxies;
 *   - `git log kanbai/publish` is the deploy history.
 */

export type TagState = 'pending' | 'building' | 'stale' | 'done' | 'failed' | 'superseded';
export type EventKind = 'claim' | 'renew' | 'done' | 'failed' | 'release';

export const DEFAULT_PUBLISH_BRANCH = 'kanbai/publish';

export interface PublishEvent {
  kind: EventKind;
  tag: string;
  /** Commit the tag points at. */
  commit: string;
  /** Identifies one claim across its renewals and outcome. */
  claim: string;
  by: string;
  host: string;
  /** When this event was written. */
  at: string;
  /** Claim and renew: when the claim runs out without a renewal. */
  expires?: string;
  /** Done and failed. */
  started?: string;
  durationMs?: number;
  exitCode?: number;
  log?: string;
}

export interface TagStatus {
  tag: string;
  commit: string;
  state: TagState;
  /** The live or expired claim. */
  lock?: PublishEvent;
  done?: PublishEvent;
  failed?: PublishEvent;
}

export function parseEvent(message: string | undefined): PublishEvent | undefined {
  if (!message) return undefined;
  try {
    const value = JSON.parse(message) as PublishEvent;
    return value && typeof value === 'object' && typeof value.tag === 'string' && typeof value.kind === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `v*` → matches v1.2.0. Supports * and ?. */
export function matchesTagPattern(tag: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return regex.test(tag);
}

/** Newest first, comparing the numbers inside tags (v1.10.0 after v1.9.0). */
export function compareVersionsDesc(a: string, b: string): number {
  const parts = (tag: string) => tag.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return y - x;
    return String(y).localeCompare(String(x));
  }
  return 0;
}

/** Replays the branch's events (oldest first) into the latest lock, done and failed per tag. */
export function replayEvents(events: PublishEvent[]): Map<string, { lock?: PublishEvent; done?: PublishEvent; failed?: PublishEvent }> {
  const state = new Map<string, { lock?: PublishEvent; done?: PublishEvent; failed?: PublishEvent }>();
  for (const event of events) {
    const current = { ...state.get(event.tag) };
    switch (event.kind) {
      case 'claim':
        current.lock = event;
        break;
      case 'renew':
        if (current.lock?.claim === event.claim) current.lock = event;
        break;
      case 'done':
        current.done = event;
        delete current.failed;
        if (current.lock?.claim === event.claim) delete current.lock;
        break;
      case 'failed':
        current.failed = event;
        if (current.lock?.claim === event.claim) delete current.lock;
        break;
      case 'release':
        delete current.lock;
        break;
    }
    state.set(event.tag, current);
  }
  return state;
}

/**
 * Each tag's state. Only the newest tag that isn't done is "pending": older open tags are
 * superseded, since publishing always deploys the latest.
 */
export function publishStatuses(tags: { tag: string; commit: string }[], events: PublishEvent[], now = new Date()): TagStatus[] {
  const replayed = replayEvents(events);
  const sorted = [...tags].sort((a, b) => compareVersionsDesc(a.tag, b.tag));
  return sorted.map(({ tag, commit }, index) => {
    const { lock, done, failed } = replayed.get(tag) ?? {};
    let state: TagState;
    if (done) state = 'done';
    else if (lock) state = lock.expires && new Date(lock.expires) < now ? 'stale' : 'building';
    else if (failed) state = 'failed';
    else state = index === 0 ? 'pending' : 'superseded';
    return { tag, commit, state, lock: done ? undefined : lock, done, failed };
  });
}
