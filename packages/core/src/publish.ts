/** Shared rules for git-based publishing; the CLI does the git work, the MCP only reads. */

export type TagState = 'pending' | 'building' | 'stale' | 'done' | 'failed' | 'superseded';

export interface Marker {
  tag: string;
  commit: string;
  by: string;
  host: string;
  at: string;
  /** Lock only: when the claim runs out without a heartbeat. */
  expires?: string;
  /** Done and failed only. */
  finished?: string;
  durationMs?: number;
  exitCode?: number;
  log?: string;
}

export interface TagStatus {
  tag: string;
  commit: string;
  state: TagState;
  lock?: Marker;
  done?: Marker;
  failed?: Marker;
}

export const PUBLISH_NAMESPACE = 'refs/kanbai';

export function parseMarker(message: string | undefined): Marker | undefined {
  if (!message) return undefined;
  try {
    const value = JSON.parse(message) as Marker;
    return typeof value === 'object' && value && typeof value.tag === 'string' ? value : undefined;
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

/**
 * Works out each tag's state from its markers. Only the newest tag that isn't done is "pending":
 * older open tags are superseded, since publishing always deploys the latest.
 */
export function publishStatuses(
  tags: { tag: string; commit: string }[],
  markers: Map<string, { lock?: Marker; done?: Marker; failed?: Marker }>,
  now = new Date(),
): TagStatus[] {
  const sorted = [...tags].sort((a, b) => compareVersionsDesc(a.tag, b.tag));
  return sorted.map(({ tag, commit }, index) => {
    const { lock, done, failed } = markers.get(tag) ?? {};
    let state: TagState;
    if (done) state = 'done';
    else if (lock) state = lock.expires && new Date(lock.expires) < now ? 'stale' : 'building';
    else if (failed) state = 'failed';
    else state = index === 0 ? 'pending' : 'superseded';
    return { tag, commit, state, lock, done, failed };
  });
}
