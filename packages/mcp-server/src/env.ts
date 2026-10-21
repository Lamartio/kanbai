import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { NumberDispenser } from './dispenser.js';

export interface Env {
  /** OAuth grants and tokens (required by workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Read cache per commit, and per-user settings such as the default repo. */
  BOARD_KV: KVNamespace;
  DISPENSER: DurableObjectNamespace<NumberDispenser>;
  /** Set by OAuthProvider for the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Public URL of this Worker, without a trailing slash, e.g. https://kanbai.you.workers.dev */
  PUBLIC_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/** What a signed-in session carries, encrypted inside the OAuth grant. */
export interface Props extends Record<string, unknown> {
  login: string;
  githubId: number;
  name: string | null;
  accessToken: string;
}
