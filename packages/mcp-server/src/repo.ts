import {
  CONFIG_PATH,
  FALLBACK_BOARDS,
  type BoardConfig,
  type FileChange,
  type LoadedBoard,
  type Snapshot,
  loadBoard,
  resolveConfig,
} from '@kanbai/core';
import type { Env, Props } from './env.js';
import { GitHub, type RepoRef, StaleHeadError, parseRepo, repoKey } from './github.js';

const CACHE_TTL = 60 * 60 * 24 * 3;
const CACHE_VERSION = 'v1';

export class UserError extends Error {}

export interface RepoState {
  repo: RepoRef;
  branch: string;
  snapshot: Snapshot;
  config: BoardConfig;
  configSource: 'file' | 'fallback' | 'default';
  board: LoadedBoard;
}

/** Everything a tool needs for one repo: reading through the per-commit cache, numbers, commits. */
export class RepoSession {
  readonly github: GitHub;

  constructor(
    readonly env: Env,
    readonly props: Props,
  ) {
    this.github = new GitHub(props.accessToken);
  }

  private defaultKey() {
    return `default-repo:${this.props.githubId}`;
  }

  async setDefaultRepo(repo: RepoRef): Promise<void> {
    await this.env.BOARD_KV.put(this.defaultKey(), `${repo.owner}/${repo.name}`);
  }

  async resolveRepo(value: string | undefined): Promise<RepoRef> {
    if (value) {
      const repo = parseRepo(value);
      if (!repo) throw new UserError(`"${value}" isn't a repo. Use owner/name, like lamartio/kanbai.`);
      return repo;
    }
    const stored = await this.env.BOARD_KV.get(this.defaultKey());
    if (stored) return parseRepo(stored)!;
    throw new UserError('No repo given and no default repo set. Pass repo (owner/name), or call set_default_repo first. list_repos shows the options.');
  }

  /** Reads the repo at its current head; served from the cache when that commit was read before. */
  async load(repoValue: string | undefined): Promise<RepoState> {
    const repo = await this.resolveRepo(repoValue);
    const head = await this.github.head(repo);
    return this.loadAt(repo, head.branch, head.oid);
  }

  private async loadAt(repo: RepoRef, branch: string, oid: string): Promise<RepoState> {
    const cacheKey = `snapshot:${CACHE_VERSION}:${repoKey(repo)}:${oid}`;
    let snapshot = await this.env.BOARD_KV.get<Snapshot>(cacheKey, 'json');
    if (!snapshot) {
      const configOnly = await this.github.readTree(repo, oid, [], [CONFIG_PATH]);
      const rawConfig = configOnly.files[CONFIG_PATH];
      const existing = rawConfig === undefined ? await this.github.existingDirs(repo, oid, FALLBACK_BOARDS) : [];
      const preliminary = resolveConfig(rawConfig, existing);
      if (!preliminary.ok) throw new UserError(preliminary.error);
      const { docs, board } = preliminary.config;
      const dirs = board === docs || board.startsWith(`${docs}/`) ? [docs] : [docs, board];
      snapshot = await this.github.readTree(repo, oid, dirs, [CONFIG_PATH]);
      // Fallback detection needs the folder list, which the tree read provides as well.
      snapshot.dirs = [...new Set([...(snapshot.dirs ?? []), ...existing])];
      await this.env.BOARD_KV.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL });
    }
    const resolved = resolveConfig(snapshot.files[CONFIG_PATH], snapshot.dirs ?? []);
    if (!resolved.ok) throw new UserError(resolved.error);
    return { repo, branch, snapshot, config: resolved.config, configSource: resolved.source, board: loadBoard(snapshot, resolved.config) };
  }

  private dispenser(repo: RepoRef) {
    return this.env.DISPENSER.get(this.env.DISPENSER.idFromName(repoKey(repo)));
  }

  /** Hands out `count` numbers on a board, never below what the repo already contains. */
  reserveNumbers(state: RepoState, board: string, count: number): Promise<number[]> {
    const floor = (state.board.highest.get(board) ?? 0) + 1;
    return this.dispenser(state.repo).reserve(board, count, floor);
  }

  peekNumbers(state: RepoState, boards: string[]): Promise<Record<string, number>> {
    return this.dispenser(state.repo).peek(boards);
  }

  bumpNumbers(state: RepoState, board: string, floor: number): Promise<number> {
    return this.dispenser(state.repo).bump(board, floor);
  }

  /**
   * Commits the changes `build` computes from the repo state. When the branch moved in the
   * meantime (someone pushed), it re-reads the repo and builds again, up to three times.
   * Numbers reserved inside `build` stay reserved across retries; reserve them before calling.
   */
  async commit<T>(
    repoValue: string | undefined,
    build: (state: RepoState) => Promise<{ changes: FileChange[]; headline: string; body?: string; result: T }> | { changes: FileChange[]; headline: string; body?: string; result: T },
    initial?: RepoState,
  ): Promise<{ result: T; commit?: { oid: string; url: string }; state: RepoState }> {
    let state = initial ?? (await this.load(repoValue));
    for (let attempt = 0; attempt < 3; attempt++) {
      const { changes, headline, body, result } = await build(state);
      if (!changes.length) return { result, state };
      try {
        const commit = await this.github.commit(state.repo, state.branch, state.snapshot.commit, changes, headline, body);
        return { result, commit, state };
      } catch (error) {
        if (!(error instanceof StaleHeadError) || attempt === 2) throw error;
        state = await this.load(`${state.repo.owner}/${state.repo.name}`);
      }
    }
    throw new Error('unreachable');
  }
}
