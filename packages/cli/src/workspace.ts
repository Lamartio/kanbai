import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { CONFIG_PATH, FALLBACK_BOARDS, type BoardConfig, type FileChange, type Snapshot, resolveConfig } from '@kanbai/core';

/** The repo root: the nearest folder upwards with a `.git` or `.board.json`. */
export function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, CONFIG_PATH))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const TEXT = /\.(mdx?|json|ya?ml|d2|txt)$/i;

function walk(root: string, dir: string, files: Record<string, string>, dirs: string[]) {
  const absolute = join(root, dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return;
  dirs.push(dir);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, path, files, dirs);
    else if (TEXT.test(entry.name)) files[path] = readFileSync(join(root, path), 'utf8');
  }
}

export interface Workspace {
  root: string;
  snapshot: Snapshot;
  config: BoardConfig;
  hasConfigFile: boolean;
}

/** Reads the working copy the same way the MCP reads GitHub: `.board.json` plus the docs folder. */
export function loadWorkspace(root: string): Workspace {
  const configPath = join(root, CONFIG_PATH);
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const existing = FALLBACK_BOARDS.filter((dir) => existsSync(join(root, dir)));
  const resolved = resolveConfig(raw, existing);
  if (!resolved.ok) throw new Error(resolved.error);
  const { docs, board } = resolved.config;
  const files: Record<string, string> = {};
  const dirs: string[] = [];
  walk(root, docs, files, dirs);
  if (!(board === docs || board.startsWith(`${docs}/`))) walk(root, board, files, dirs);
  if (raw !== undefined) files[CONFIG_PATH] = raw;
  return { root, snapshot: { commit: 'working-copy', files, dirs }, config: resolved.config, hasConfigFile: raw !== undefined };
}

/** Writes and deletes files in the working copy. Nothing is committed: that stays with you (or the agent). */
export function applyChanges(root: string, changes: FileChange[]): string[] {
  const touched: string[] = [];
  for (const change of changes) {
    const absolute = join(root, ...change.path.split('/'));
    if (!absolute.startsWith(root + sep) && absolute !== root) throw new Error(`Refusing to write outside the repo: ${change.path}`);
    if (change.content === null) {
      if (existsSync(absolute)) rmSync(absolute);
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, change.content);
    }
    touched.push(relative(root, absolute).split(sep).join('/'));
  }
  return touched;
}
