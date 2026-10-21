import { DurableObject } from 'cloudflare:workers';

/**
 * One instance per repo: the single place issue numbers come from.
 * A Durable Object handles one request at a time, so two chats (or two local agents)
 * can never receive the same number. Numbers count per board and are never handed out twice,
 * even when the commit that would have used them fails: gaps are fine, reuse is not.
 */
export class NumberDispenser extends DurableObject {
  private key(board: string) {
    return `next:${board}`;
  }

  /**
   * Hands out `count` consecutive numbers on `board`.
   * `floor` is one above the highest number already in the repo, so issues made by hand never collide.
   */
  async reserve(board: string, count: number, floor: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be between 1 and 100.');
    const stored = (await this.ctx.storage.get<number>(this.key(board))) ?? 1;
    const first = Math.max(stored, floor, 1);
    await this.ctx.storage.put(this.key(board), first + count);
    return Array.from({ length: count }, (_, index) => first + index);
  }

  /** The next number per board, without handing it out. */
  async peek(boards: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const board of boards) result[board] = (await this.ctx.storage.get<number>(this.key(board))) ?? 1;
    return result;
  }

  /** Moves a board's counter past `floor` (the doctor does this when the repo is ahead). */
  async bump(board: string, floor: number): Promise<number> {
    const stored = (await this.ctx.storage.get<number>(this.key(board))) ?? 1;
    const next = Math.max(stored, floor);
    if (next !== stored) await this.ctx.storage.put(this.key(board), next);
    return next;
  }
}
