import { describe, expect, it } from 'vitest';
import { compareVersionsDesc, matchesTagPattern, publishStatuses, replayEvents } from '../src/index.js';

describe('publish rules', () => {
  it('sorts versions newest first by their numbers', () => {
    expect(['v1.9.0', 'v1.10.0', 'v1.2.3'].sort(compareVersionsDesc)).toEqual(['v1.10.0', 'v1.9.0', 'v1.2.3']);
  });

  it('matches tag patterns', () => {
    expect(matchesTagPattern('v1.2.0', 'v*')).toBe(true);
    expect(matchesTagPattern('release-1', 'v*')).toBe(false);
    expect(matchesTagPattern('app-v1.0.0', 'app-v*')).toBe(true);
  });

  it('works out states: only the newest open tag is pending', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const statuses = publishStatuses(
      [
        { tag: 'v1.0.0', commit: 'a' },
        { tag: 'v1.2.0', commit: 'c' },
        { tag: 'v1.1.0', commit: 'b' },
      ],
      [{ kind: 'claim', tag: 'v1.2.0', commit: 'c', claim: 'k', by: 'x', host: 'y', at: '', expires: '2026-10-21T11:00:00Z' }],
      now,
    );
    expect(statuses.map((status) => [status.tag, status.state])).toEqual([
      ['v1.2.0', 'stale'],
      ['v1.1.0', 'superseded'],
      ['v1.0.0', 'superseded'],
    ]);
  });

  it('replays claims, renewals and outcomes per claim', () => {
    const base = { tag: 'v1', commit: 'c', by: 'a', host: 'h', at: '' } as const;
    const state = replayEvents([
      { ...base, kind: 'claim', claim: 'one' },
      { ...base, kind: 'failed', claim: 'one', exitCode: 2 },
      { ...base, kind: 'claim', claim: 'two' },
      { ...base, kind: 'renew', claim: 'one' },
      { ...base, kind: 'done', claim: 'two' },
    ]).get('v1')!;
    expect(state.done?.claim).toBe('two');
    expect(state.failed).toBeUndefined();
    expect(state.lock).toBeUndefined();
  });
});
