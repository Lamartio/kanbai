import { NumberDispenser } from '../src/dispenser.js';
import type { Env, Props } from '../src/env.js';

/** An in-memory GitHub repo that answers the few API calls the server makes. */
export class FakeGitHub {
  files: Record<string, string>;
  head = 'c0';
  commits: { oid: string; headline: string; paths: string[] }[] = [];
  private counter = 0;

  constructor(files: Record<string, string> = {}) {
    this.files = { 'README.md': '# Test\n', ...files };
  }

  /** Simulates someone pushing outside kanbai. */
  push(files: Record<string, string | null>) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) delete this.files[path];
      else this.files[path] = content;
    }
    this.head = `c${++this.counter}`;
  }

  private tree(dir: string): unknown[] | null {
    const prefix = `${dir}/`;
    const names = new Map<string, 'blob' | 'tree'>();
    for (const path of Object.keys(this.files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [first, ...more] = rest.split('/');
      names.set(first!, more.length ? 'tree' : (names.get(first!) ?? 'blob'));
    }
    if (!names.size) return null;
    return [...names].map(([name, type]) =>
      type === 'tree'
        ? { name, type, object: { entries: this.tree(`${prefix}${name}`) } }
        : { name, type, object: { text: this.files[`${prefix}${name}`], isBinary: false, byteSize: this.files[`${prefix}${name}`]!.length } },
    );
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.github.com') throw new Error(`Unexpected fetch to ${url.href}`);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/user/repos') return json([{ full_name: 'lamartio/test', private: true, pushed_at: '', description: 'Test repo', permissions: { push: true } }]);
    if (url.pathname === '/user') return json({ id: 1, login: 'lamartio', name: 'Danny' });
    if (url.pathname.startsWith('/repos/lamartio/test/contents/')) {
      const path = decodeURIComponent(url.pathname.slice('/repos/lamartio/test/contents/'.length));
      return path in this.files ? new Response(this.files[path]) : json({ message: 'Not Found' }, 404);
    }
    if (url.pathname !== '/graphql') return json({ message: 'Not Found' }, 404);

    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    if (query.includes('createCommitOnBranch')) {
      const input = variables.input;
      if (input.expectedHeadOid !== this.head) return json({ data: null, errors: [{ message: `Expected branch to point to "${input.expectedHeadOid}" but it did not` }] });
      for (const addition of input.fileChanges.additions) {
        this.files[addition.path] = new TextDecoder().decode(Uint8Array.from(atob(addition.contents), (char) => char.charCodeAt(0)));
      }
      for (const deletion of input.fileChanges.deletions) delete this.files[deletion.path];
      this.head = `c${++this.counter}`;
      this.commits.push({ oid: this.head, headline: input.message.headline, paths: [...input.fileChanges.additions, ...input.fileChanges.deletions].map((change: { path: string }) => change.path) });
      return json({ data: { createCommitOnBranch: { commit: { oid: this.head, url: `https://github.com/lamartio/test/commit/${this.head}` } } } });
    }
    if (query.includes('defaultBranchRef')) {
      return json({ data: { repository: { defaultBranchRef: { name: 'main', target: { oid: this.head } } } } });
    }
    const repository: Record<string, unknown> = {};
    for (const match of query.matchAll(/(\w+): object\(expression: ("(?:[^"\\]|\\.)*")\) \{ (\.\.\. on (Tree|Blob)|__typename)/g)) {
      const [, alias, expression, , kind] = match;
      const path = (JSON.parse(expression!) as string).split(':').slice(1).join(':');
      const tree = this.tree(path);
      if (!kind) repository[alias!] = tree ? { __typename: 'Tree' } : path in this.files ? { __typename: 'Blob' } : null;
      else if (kind === 'Tree') repository[alias!] = tree ? { entries: tree } : null;
      else repository[alias!] = path in this.files ? { text: this.files[path] } : null;
    }
    return json({ data: { repository } });
  };
}

class FakeKV {
  store = new Map<string, string>();
  async get(key: string, type?: 'json') {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

export function fakeEnv(): Env {
  const instances = new Map<string, NumberDispenser>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!instances.has(id)) {
        const map = new Map<string, unknown>();
        const ctx = { storage: { get: async (key: string) => map.get(key), put: async (key: string, value: unknown) => void map.set(key, value) } };
        instances.set(id, new (NumberDispenser as any)(ctx, {}));
      }
      return instances.get(id)!;
    },
  };
  return {
    OAUTH_KV: new FakeKV() as unknown as KVNamespace,
    BOARD_KV: new FakeKV() as unknown as KVNamespace,
    DISPENSER: namespace as unknown as Env['DISPENSER'],
    OAUTH_PROVIDER: undefined as unknown as Env['OAUTH_PROVIDER'],
    PUBLIC_URL: 'http://localhost',
    GITHUB_CLIENT_ID: 'x',
    GITHUB_CLIENT_SECRET: 'y',
  };
}

export const props: Props = { login: 'lamartio', githubId: 1, name: 'Danny', accessToken: 'fake' };
