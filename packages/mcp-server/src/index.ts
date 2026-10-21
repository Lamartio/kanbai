import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler } from './auth.js';
import type { Env, Props } from './env.js';
import { createServer } from './tools.js';

export { NumberDispenser } from './dispenser.js';

/** The MCP endpoint. Every request builds a fresh server: there is no session state to keep. */
const mcpHandler = {
  fetch(request, env, ctx) {
    const props = (ctx as ExecutionContext & { props: Props }).props;
    return createMcpHandler(() => createServer(env, props), { route: '/mcp' })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  if (!env.PUBLIC_URL) throw new Error('Set PUBLIC_URL (the Worker\'s https URL) in wrangler.jsonc vars.');
  const base = env.PUBLIC_URL.replace(/\/+$/, '');
  provider ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      resource_name: 'kanbai',
    },
  });
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
