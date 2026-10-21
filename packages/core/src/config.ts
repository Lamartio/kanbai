/** The `.board.json` file at the root of a target repo. */
export interface BoardConfig {
  /** Docs folder, relative to the repo root. */
  docs: string;
  /** Board folder, relative to the repo root. */
  board: string;
  /** Lanes, in board order. The first lane is where new issues land. */
  lanes: string[];
  /** Where attachments live. */
  attachments: 'lfs' | 'r2';
  /** The lane that replaces deleting: always the last lane. */
  archive: string;
  /** How `kanbai publish` builds and deploys a version tag on a client. Optional. */
  publish?: PublishConfig;
}

export interface PublishConfig {
  /** Shell command run in a clean checkout of the tag, e.g. "npm ci && npm run deploy". */
  command: string;
  /** Glob for version tags. Default: v*. */
  tags: string;
  /** Minutes a claim lasts without a heartbeat before another client may take over. Default: 30. */
  leaseMinutes: number;
  /** Branch that holds the publish events (claims, outcomes). Default: kanbai/publish. */
  branch: string;
  /** Environment variables the command needs (deploy secrets). Checked before claiming. */
  requires: string[];
}

export const CONFIG_PATH = '.board.json';

export const DEFAULT_CONFIG: BoardConfig = {
  docs: 'docs',
  board: 'docs/board',
  lanes: ['TODO', 'DOING', 'DONE', 'ARCHIVED'],
  attachments: 'lfs',
  archive: 'ARCHIVED',
};

/** Folders tried, in order, when a repo has no `.board.json`. */
export const FALLBACK_BOARDS = ['docs/board', 'wiki/board'];

export type ConfigResult =
  | { ok: true; config: BoardConfig; source: 'file' | 'fallback' | 'default' }
  | { ok: false; error: string };

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, '');

/**
 * Reads `.board.json`. Without the file, falls back to the first existing folder
 * in FALLBACK_BOARDS (`existingDirs` says which exist), then to the defaults.
 */
export function resolveConfig(raw: string | undefined, existingDirs: Iterable<string> = []): ConfigResult {
  if (raw === undefined) {
    const dirs = new Set(existingDirs);
    const board = FALLBACK_BOARDS.find((dir) => dirs.has(dir));
    if (board) {
      const docs = board.slice(0, board.lastIndexOf('/'));
      return { ok: true, config: { ...DEFAULT_CONFIG, docs, board }, source: 'fallback' };
    }
    return { ok: true, config: DEFAULT_CONFIG, source: 'default' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${CONFIG_PATH} is not valid JSON.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${CONFIG_PATH} must contain a JSON object.` };
  }
  const value = parsed as Record<string, unknown>;
  const config: BoardConfig = { ...DEFAULT_CONFIG };
  if (value.docs !== undefined) {
    if (typeof value.docs !== 'string' || !value.docs.trim()) return { ok: false, error: '"docs" must be a folder path.' };
    config.docs = trimSlashes(value.docs);
  }
  if (value.board !== undefined) {
    if (typeof value.board !== 'string' || !value.board.trim()) return { ok: false, error: '"board" must be a folder path.' };
    config.board = trimSlashes(value.board);
  } else if (value.docs !== undefined) {
    config.board = `${config.docs}/board`;
  }
  if (value.lanes !== undefined) {
    const lanes = value.lanes;
    if (!Array.isArray(lanes) || lanes.length === 0 || !lanes.every((lane) => typeof lane === 'string' && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(lane))) {
      return { ok: false, error: '"lanes" must be a non-empty list of kebab-case names.' };
    }
    if (new Set(lanes).size !== lanes.length) return { ok: false, error: '"lanes" contains duplicates.' };
    config.lanes = lanes as string[];
  }
  if (value.attachments !== undefined) {
    if (value.attachments !== 'lfs' && value.attachments !== 'r2') return { ok: false, error: '"attachments" must be "lfs" or "r2".' };
    config.attachments = value.attachments;
  }
  if (value.publish !== undefined) {
    const publish = value.publish as Record<string, unknown> | null;
    if (typeof publish !== 'object' || publish === null || Array.isArray(publish)) return { ok: false, error: '"publish" must be an object.' };
    if (typeof publish.command !== 'string' || !publish.command.trim()) return { ok: false, error: '"publish.command" must be the shell command that builds and deploys.' };
    const tags = publish.tags ?? 'v*';
    const leaseMinutes = publish.leaseMinutes ?? 30;
    if (typeof tags !== 'string' || !tags.trim()) return { ok: false, error: '"publish.tags" must be a tag pattern, like v*.' };
    if (typeof leaseMinutes !== 'number' || !(leaseMinutes > 0)) return { ok: false, error: '"publish.leaseMinutes" must be a positive number.' };
    const branch = publish.branch ?? 'kanbai/publish';
    if (typeof branch !== 'string' || !/^[\w.-]+(\/[\w.-]+)*$/.test(branch)) return { ok: false, error: '"publish.branch" must be a branch name.' };
    const requires = publish.requires ?? [];
    if (!Array.isArray(requires) || !requires.every((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      return { ok: false, error: '"publish.requires" must be a list of environment variable names.' };
    }
    config.publish = { command: publish.command, tags, leaseMinutes, branch, requires: requires as string[] };
  }
  if (value.archive !== undefined) {
    if (typeof value.archive !== 'string') return { ok: false, error: '"archive" must be a lane name.' };
    config.archive = value.archive;
  } else if (value.lanes !== undefined) {
    // No archive named: reuse an "archived" lane in any case, or add one in the style of the others.
    const existing = config.lanes.find((lane) => lane.toLowerCase() === 'archived');
    if (existing) config.archive = existing;
    else {
      config.archive = config.lanes.every((lane) => lane === lane.toLowerCase()) ? 'archived' : 'ARCHIVED';
      config.lanes = [...config.lanes, config.archive];
    }
  }
  if (config.lanes[config.lanes.length - 1] !== config.archive) {
    return { ok: false, error: `The archive lane "${config.archive}" must be the last lane.` };
  }
  if (config.lanes.length < 2) return { ok: false, error: 'There must be at least one lane before the archive lane.' };
  return { ok: true, config, source: 'file' };
}

export function serializeConfig(config: BoardConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
