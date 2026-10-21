import { AuthorizationError, CimdFetchError, type ConsentDescription, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import type { Env, Props } from './env.js';
import { GitHub } from './github.js';

/**
 * The sign-in pages: Claude sends the user to /authorize, they approve, GitHub signs them in,
 * and /callback finishes. The GitHub token ends up encrypted in the grant's props.
 */

const GITHUB_SCOPES = 'repo read:user';
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafaf9; --muted: #6b6b6b; --accent: #2f5bd3; --card: #fff; --line: #e4e4e2; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #161616; --muted: #9a9a9a; --accent: #7c9cff; --card: #1f1f1f; --line: #2e2e2e; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: grid; place-items: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }
  main { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; max-width: 440px; width: 100%; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { margin: 8px 0; } .muted { color: var(--muted); font-size: .9rem; }
  .warn { background: color-mix(in srgb, orange 18%, transparent); border-radius: 8px; padding: 8px 12px; }
  .row { display: flex; gap: 8px; margin-top: 20px; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; flex: 1; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
<main>${body}</main></html>`,
    { status, headers },
  );
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return `<h1>Allow ${name} to use kanbai?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>Next, GitHub asks you to sign in. kanbai can then read and write the repos your GitHub account can reach, to keep their boards.</p>
<form method="post" class="row">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="deny">Deny</button>
  <button name="decision" value="approve" class="primary">Continue to GitHub</button>
</form>`;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const callbackUrl = (env: Env) => `${env.PUBLIC_URL}/callback`;

function errorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    const redirect = (error as AuthorizationError & { redirectTo?: string }).redirectTo;
    if (redirect) return Response.redirect(redirect, 302);
    return page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escape(error.description)}</p><p class="muted">Start again from Claude.</p>`, new Headers(), 400);
  }
  if (error instanceof CimdFetchError) {
    return page('Sign-in failed', '<h1>Sign-in failed</h1><p>This app could not be verified.</p>', new Headers(), 400);
  }
  throw error;
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return page('Authorize kanbai', consentPage(details, consent.handle), consent.headers);
      }

      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') ?? '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        const github = new URL('https://github.com/login/oauth/authorize');
        github.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        github.searchParams.set('redirect_uri', callbackUrl(env));
        github.searchParams.set('scope', GITHUB_SCOPES);
        github.searchParams.set('state', state);
        github.searchParams.set('code_challenge', await s256(verifier));
        github.searchParams.set('code_challenge_method', 'S256');
        headers.set('Location', github.toString());
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/callback') {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
        const code = url.searchParams.get('code');
        if (url.searchParams.get('error') || !code) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'kanbai-mcp' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: callbackUrl(env),
            code_verifier: data.verifier,
          }),
        });
        const token = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
        if (!token.access_token) {
          return page('Sign-in failed', `<h1>GitHub sign-in failed</h1><p>${escape(token.error_description ?? token.error ?? 'No access token.')}</p>`, new Headers(), 400);
        }
        const user = await new GitHub(token.access_token).user();
        const props: Props = { login: user.login, githubId: user.id, name: user.name, accessToken: token.access_token };
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: String(user.id),
          metadata: { login: user.login },
          scope: original.scope,
          props,
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/') {
        return page(
          'kanbai',
          `<h1>kanbai</h1><p>An MCP server that keeps a kanban board and docs as markdown in your GitHub repos.</p>
<p class="muted">Add <strong>${escape(env.PUBLIC_URL)}/mcp</strong> as a custom connector in Claude.</p>`,
        );
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
