import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { classifyPath } from './naming.js';

export const ISSUE_TYPES = ['feature', 'bug', 'idea', 'decision'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const LINK_KINDS = ['blocks', 'relates', 'parent'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export type IssueLinks = Partial<Record<LinkKind, number[]>>;

/** The sections of an issue body, in the order they are written. */
export const SECTIONS = ['Why', 'Done when', 'Context', 'Constraints / not doing', 'Decisions', 'Open questions', 'Log'] as const;
export type SectionName = (typeof SECTIONS)[number];

export interface Frontmatter {
  title: string;
  type: IssueType;
  status: string;
  assignee?: string;
  created: string;
  tags: string[];
  links: IssueLinks;
  attachments: string[];
  released?: string;
  /** Unknown fields are kept as they are. */
  [key: string]: unknown;
}

export interface Issue {
  /** Board name; '' for the main board. */
  board: string;
  number: number;
  slug: string;
  /** Repo path of the parent issue's file, for sub-issues. */
  parentPath?: string;
  /** Path relative to the repo root. */
  path: string;
  frontmatter: Frontmatter;
  /** Markdown after the frontmatter. */
  body: string;
}



// ---------------------------------------------------------------- sections

const HEADING_RE = /^## (.+?)\s*$/;

/** Splits a body into its `## ` sections. Text before the first heading is kept under `''`. */
export function splitSections(body: string): { name: string; content: string }[] {
  const lines = body.split('\n');
  const sections: { name: string; lines: string[] }[] = [{ name: '', lines: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && HEADING_RE.exec(line);
    if (match) sections.push({ name: match[1]!, lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  return sections
    .map((section) => ({ name: section.name, content: section.lines.join('\n').trim() }))
    .filter((section, index) => index > 0 || section.content);
}

export function joinSections(sections: { name: string; content: string }[]): string {
  return (
    sections
      .map((section) => (section.name ? `## ${section.name}\n\n${section.content}`.trimEnd() : section.content))
      .join('\n\n')
      .trim() + '\n'
  );
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function getSection(body: string, name: string): string | undefined {
  return splitSections(body).find((section) => sameName(section.name, name))?.content;
}

/** Sets a section's content; adds it in the standard order when it isn't there yet. */
export function setSection(body: string, name: string, content: string): string {
  const sections = splitSections(body);
  const existing = sections.find((section) => sameName(section.name, name));
  if (existing) {
    existing.content = content.trim();
    return joinSections(sections);
  }
  const order = (sectionName: string) => {
    const index = SECTIONS.findIndex((standard) => sameName(standard, sectionName));
    return index === -1 ? SECTIONS.length : index;
  };
  const position = sections.findIndex((section) => section.name && order(section.name) > order(name));
  const entry = { name, content: content.trim() };
  if (position === -1) sections.push(entry);
  else sections.splice(position, 0, entry);
  return joinSections(sections);
}

/** True when a section has real content, not just empty checkboxes, an ellipsis or placeholders. */
export function hasContent(content: string | undefined): boolean {
  if (!content) return false;
  const meaningful = content
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter((line) => line && !/^(…|\.\.\.|todo|tbd)$/i.test(line) && !line.startsWith('<!--'));
  return meaningful.length > 0;
}

/** Adds a dated line to the Log section. */
export function appendLog(body: string, date: string, text: string): string {
  const current = getSection(body, 'Log') ?? '';
  const line = `- ${date}: ${text.trim()}`;
  return setSection(body, 'Log', current ? `${current}\n${line}` : line);
}

// ------------------------------------------------------------- parse/write

export type ParseResult = { ok: true; issue: Issue } | { ok: false; path: string; error: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function toNumberList(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value) return [value];
  return [];
}

/** `path` is relative to the repo root; `boardDir` is `config.board`. */
export function parseIssue(path: string, text: string, boardDir: string): ParseResult {
  if (!path.startsWith(`${boardDir}/`)) return { ok: false, path, error: 'Not inside the board folder.' };
  const kind = classifyPath(path.slice(boardDir.length + 1));
  if (kind.kind === 'invalid') return { ok: false, path, error: kind.reason };
  if (kind.kind !== 'issue') return { ok: false, path, error: 'Not an issue file.' };
  const where = kind.location;
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { ok: false, path, error: 'No frontmatter found.' };
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    return { ok: false, path, error: `Frontmatter is not valid YAML: ${(error as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, path, error: 'Frontmatter must be a YAML mapping.' };
  }
  const raw = data as Record<string, unknown>;
  const links: IssueLinks = {};
  if (raw.links && typeof raw.links === 'object' && !Array.isArray(raw.links)) {
    for (const kind of LINK_KINDS) {
      const numbers = toNumberList((raw.links as Record<string, unknown>)[kind]);
      if (numbers.length) links[kind] = numbers;
    }
  }
  const frontmatter: Frontmatter = {
    ...raw,
    title: typeof raw.title === 'string' ? raw.title : '',
    type: (ISSUE_TYPES as readonly string[]).includes(String(raw.type)) ? (raw.type as IssueType) : 'feature',
    status: typeof raw.status === 'string' ? raw.status : '',
    created: raw.created instanceof Date ? raw.created.toISOString().slice(0, 10) : raw.created ? String(raw.created) : '',
    tags: toStringList(raw.tags),
    links,
    attachments: toStringList(raw.attachments),
  };
  if (raw.assignee) frontmatter.assignee = String(raw.assignee);
  else delete frontmatter.assignee;
  if (raw.released) frontmatter.released = String(raw.released);
  else delete frontmatter.released;
  return {
    ok: true,
    issue: {
      board: where.board,
      number: where.number,
      slug: where.slug,
      path,
      ...(where.parentPath ? { parentPath: `${boardDir}/${where.parentPath}` } : {}),
      frontmatter,
      body: text.slice(match[0].length).trim() + '\n',
    },
  };
}

const ORDER = ['title', 'type', 'status', 'assignee', 'created', 'tags', 'links', 'attachments', 'released'];

export function serializeIssue(issue: Pick<Issue, 'frontmatter' | 'body'>): string {
  const ordered: Record<string, unknown> = {};
  const fm = issue.frontmatter;
  for (const key of ORDER) if (fm[key] !== undefined) ordered[key] = fm[key];
  for (const key of Object.keys(fm)) if (!ORDER.includes(key) && fm[key] !== undefined) ordered[key] = fm[key];
  const yaml = stringifyYaml(ordered, { flowCollectionPadding: false, lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${issue.body.trim()}\n`;
}
