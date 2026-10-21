import type { FileChange, Snapshot } from '@kanbai/core';

const API = 'https://api.github.com';
const USER_AGENT = 'kanbai-mcp';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Raised when the branch moved between reading and committing. The caller re-reads and retries. */
export class StaleHeadError extends Error {}

export interface RepoRef {
  owner: string;
  name: string;
}

export const repoKey = (repo: RepoRef) => `${repo.owner}/${repo.name}`.toLowerCase();

export function parseRepo(value: string): RepoRef | null {
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

export class GitHub {
  constructor(private readonly token: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  async rest<T>(path: string, init: RequestInit & { accept?: string } = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: this.headers(init.accept ? { Accept: init.accept } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {}
      throw new GitHubError(`GitHub ${response.status} on ${path}: ${message}`, response.status);
    }
    if (init.accept?.includes('raw')) return (await response.text()) as T;
    return (await response.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as { data?: T; errors?: { message: string; type?: string }[] };
    if (!response.ok || body.errors?.length) {
      const message = body.errors?.map((error) => error.message).join('; ') ?? `HTTP ${response.status}`;
      throw new GitHubError(`GitHub GraphQL: ${message}`, response.status);
    }
    return body.data!;
  }

  user(): Promise<{ id: number; login: string; name: string | null }> {
    return this.rest('/user');
  }

  async listRepos(): Promise<{ full_name: string; private: boolean; pushed_at: string; description: string | null }[]> {
    type Repo = { full_name: string; private: boolean; pushed_at: string; description: string | null; permissions?: { push?: boolean } };
    const repos = await this.rest<Repo[]>('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return repos.filter((repo) => repo.permissions?.push !== false);
  }

  /** Default branch and its head commit. */
  async head(repo: RepoRef): Promise<{ branch: string; oid: string }> {
    const data = await this.graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string } } | null } | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid } } } }`,
      { owner: repo.owner, name: repo.name },
    );
    if (!data.repository) throw new GitHubError(`Repo ${repo.owner}/${repo.name} not found, or not accessible with this login.`, 404);
    if (!data.repository.defaultBranchRef) throw new GitHubError(`Repo ${repo.owner}/${repo.name} has no commits yet. Push a first commit, then try again.`);
    return { branch: data.repository.defaultBranchRef.name, oid: data.repository.defaultBranchRef.target.oid };
  }

  /**
   * Reads `.board.json` plus every text file under `dirs`, in one query per call (not one per file).
   * Folders deeper than `depth` levels are not read.
   */
  async readTree(repo: RepoRef, oid: string, dirs: string[], extraFiles: string[], depth = 8): Promise<Snapshot> {
    const level = (remaining: number): string =>
      remaining === 0
        ? 'entries { name type }'
        : `entries { name type object { ... on Blob { text isBinary byteSize } ... on Tree { ${level(remaining - 1)} } } }`;
    const aliases = [
      ...dirs.map((dir, index) => `d${index}: object(expression: ${JSON.stringify(`${oid}:${dir}`)}) { ... on Tree { ${level(depth)} } }`),
      ...extraFiles.map((file, index) => `f${index}: object(expression: ${JSON.stringify(`${oid}:${file}`)}) { ... on Blob { text } }`),
    ];
    type Entry = { name: string; type: string; object?: { text?: string | null; isBinary?: boolean; byteSize?: number; entries?: Entry[] } | null };
    const data = await this.graphql<{ repository: Record<string, { entries?: Entry[]; text?: string | null } | null> }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases.join('\n')} } }`,
      { owner: repo.owner, name: repo.name },
    );
    const files: Record<string, string> = {};
    const dirSet = new Set<string>();
    const walk = (base: string, entries: Entry[] | undefined) => {
      for (const entry of entries ?? []) {
        const path = `${base}/${entry.name}`;
        if (entry.type === 'tree') {
          dirSet.add(path);
          walk(path, entry.object?.entries);
        } else if (entry.type === 'blob' && entry.object && !entry.object.isBinary && typeof entry.object.text === 'string' && /\.(mdx?|json|ya?ml|d2|txt)$/i.test(entry.name)) {
          files[path] = entry.object.text;
        }
      }
    };
    dirs.forEach((dir, index) => {
      const tree = data.repository[`d${index}`];
      if (tree) {
        dirSet.add(dir);
        walk(dir, tree.entries);
      }
    });
    extraFiles.forEach((file, index) => {
      const blob = data.repository[`f${index}`];
      if (blob && typeof blob.text === 'string') files[file] = blob.text;
    });
    return { commit: oid, files, dirs: [...dirSet] };
  }

  /** Which of these folders exist at a commit. */
  async existingDirs(repo: RepoRef, oid: string, dirs: string[]): Promise<string[]> {
    const aliases = dirs.map((dir, index) => `d${index}: object(expression: ${JSON.stringify(`${oid}:${dir}`)}) { __typename }`);
    const data = await this.graphql<{ repository: Record<string, { __typename: string } | null> }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases.join('\n')} } }`,
      { owner: repo.owner, name: repo.name },
    );
    return dirs.filter((_, index) => data.repository[`d${index}`]?.__typename === 'Tree');
  }

  /** Version tags (with their commits) and kanbai publish markers, in one query. */
  async publishRefs(repo: RepoRef): Promise<{ tags: { tag: string; commit: string }[]; markers: { name: string; message: string }[] }> {
    type Ref = { name: string; target: { oid: string; message?: string; target?: { oid: string } } | null };
    const data = await this.graphql<{ repository: { tags: { nodes: Ref[] }; kanbai: { nodes: Ref[] } } | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
        tags: refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name target { oid ... on Tag { target { oid } } } } }
        kanbai: refs(refPrefix: "refs/kanbai/", first: 100) { nodes { name target { oid ... on Commit { message } } } }
      } }`,
      { owner: repo.owner, name: repo.name },
    );
    if (!data.repository) throw new GitHubError(`Repo ${repo.owner}/${repo.name} not found, or not accessible with this login.`, 404);
    return {
      tags: data.repository.tags.nodes.map((ref) => ({ tag: ref.name, commit: ref.target?.target?.oid ?? ref.target?.oid ?? '' })),
      markers: data.repository.kanbai.nodes.map((ref) => ({ name: ref.name, message: ref.target?.message ?? '' })),
    };
  }

  /** One small file at a commit, as text. Returns null when missing or too large. */
  async readFile(repo: RepoRef, oid: string, path: string, maxBytes = 20_000): Promise<string | null> {
    try {
      const text = await this.rest<string>(`/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${oid}`, {
        accept: 'application/vnd.github.raw+json',
      });
      return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… (cut at ${maxBytes} characters)` : text;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  /**
   * Commits all changes at once on the branch, only if the branch still points at `expectedHead`.
   * GitHub signs these commits, so they show as verified.
   */
  async commit(repo: RepoRef, branch: string, expectedHead: string, changes: FileChange[], headline: string, body?: string): Promise<{ oid: string; url: string }> {
    const additions = changes.filter((change) => change.content !== null).map((change) => ({ path: change.path, contents: toBase64(change.content!) }));
    const deletions = changes.filter((change) => change.content === null).map((change) => ({ path: change.path }));
    try {
      const data = await this.graphql<{ createCommitOnBranch: { commit: { oid: string; url: string } } }>(
        `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }`,
        {
          input: {
            branch: { repositoryNameWithOwner: `${repo.owner}/${repo.name}`, branchName: branch },
            expectedHeadOid: expectedHead,
            message: { headline, ...(body ? { body } : {}) },
            fileChanges: { additions, deletions },
          },
        },
      );
      return data.createCommitOnBranch.commit;
    } catch (error) {
      if (error instanceof GitHubError && /expected branch to point to|is at .* but expected/i.test(error.message)) throw new StaleHeadError(error.message);
      throw error;
    }
  }
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
