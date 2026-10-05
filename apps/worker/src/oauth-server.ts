import { OAuthAuthorizationServer, OAuthResourceServer, type OAuthResourceHandler } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "./env";
import {
  authServerOptions,
  principalFromApiToken,
  resourceServerConfig,
  type McpPrincipalProps,
} from "./mcp-oauth";
import { D1KV } from "./oauth-kv";

// Thin provider wiring for MCP OAuth (option shapes and token logic live
// in mcp-oauth.ts). This module imports the provider runtime, which needs
// `cloudflare:` modules, so vitest never touches it — staging covers it.
// Instances are built per request so each origin (production, previews,
// localhost) gets a correct issuer with zero configured URLs; the
// constructor is pure config, and the authorize flow keeps no server-side
// secrets (transaction keys derive from the cookie-held handle).

export type OAuthEnv = WorkerEnv & { OAUTH_KV: D1KV };

export function oauthEnv(env: WorkerEnv): OAuthEnv {
  return { ...env, OAUTH_KV: new D1KV(env.DB) };
}

export function createAuthServer(origin: string): OAuthAuthorizationServer<OAuthEnv> {
  return new OAuthAuthorizationServer<OAuthEnv>(authServerOptions<OAuthEnv>(origin));
}

export function createResourceServer(
  origin: string,
  authServer: OAuthAuthorizationServer<OAuthEnv>,
  handler: OAuthResourceHandler<OAuthEnv, McpPrincipalProps>,
): OAuthResourceServer<OAuthEnv, McpPrincipalProps> {
  const config = resourceServerConfig(origin);
  return new OAuthResourceServer<OAuthEnv, McpPrincipalProps>({
    resourceMetadata: {
      resource: config.resource,
      resource_name: config.resourceName,
      authorization_servers: config.authorizationServers,
    },
    requiredScopes: config.requiredScopes,
    handler,
    validateToken: (env) => async (resource, token) => {
      // OAuth access tokens first, legacy API tokens second; both
      // converge on McpPrincipalProps + OAuth scopes downstream.
      const validated = await authServer.validateToken<McpPrincipalProps>(resource, token, env).catch(() => null);
      if (validated) {
        return {
          props: validated.props,
          audience: resource,
          expiresAt: validated.expiresAt,
          scope: validated.scope,
          userId: validated.userId,
          clientId: validated.clientId,
        };
      }
      return principalFromApiToken(token, { db: env.DB, adminToken: env.ADMIN_TOKEN, runnerToken: env.RUNNER_TOKEN }, resource);
    },
  });
}
