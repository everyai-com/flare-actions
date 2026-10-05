import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
  OAuthAuthorizationServerOptions,
} from "@cloudflare/workers-oauth-provider";
import type { Db } from "./db";
import { escapeHtml } from "./notify";
import { D1KV } from "./oauth-kv";
import { authIdentityFromToken } from "./tokens";

// MCP authorization: OAuth 2.1 dynamic clients plus the legacy API
// tokens, both served from this worker (zero new infrastructure — the
// provider's KV is the D1-backed D1KV in oauth-kv.ts).
//
// This module is provider-runtime-free: it builds option objects, renders
// the consent UI, and validates tokens, but never imports the provider
// itself (which needs `cloudflare:` modules). The thin wiring that
// instantiates the provider lives in oauth-server.ts; vitest covers this
// file, staging covers that one.

// OAuth scopes for the MCP resource. flare:read gates the read tools,
// flare:run the dispatch/rerun/generate tools; offline_access (refresh
// tokens) is about longevity, not privilege, and granted to everyone.
export const MCP_OAUTH_SCOPE_READ = "flare:read";
export const MCP_OAUTH_SCOPE_RUN = "flare:run";
export const MCP_OAUTH_SCOPE_OFFLINE = "offline_access";

export const MCP_OAUTH_SCOPE_DESCRIPTIONS: Record<string, string> = {
  [MCP_OAUTH_SCOPE_READ]: "Read runs, jobs, logs, and flaky stats",
  [MCP_OAUTH_SCOPE_RUN]: "Dispatch and rerun jobs, generate pipelines",
  [MCP_OAUTH_SCOPE_OFFLINE]: "Stay connected (refresh tokens)",
};

// The identity a validated token carries into the MCP tools, identical
// for OAuth grants and legacy API tokens: an audit actor plus a repo
// allowlist ([] = every repo).
export interface McpPrincipalProps {
  actor: string;
  repos: string[];
}

export function oauthProps(login: string): McpPrincipalProps {
  return { actor: `oauth:${login}`, repos: [] };
}

// Grant storage keys are colon-separated, so user ids must not contain
// a colon: kind/login (login is a GitHub username or an email address,
// neither of which contains one).
export function oauthUserId(kind: string, login: string): string {
  return `${kind}/${login}`;
}

export function mcpResourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

function checkOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("invalid origin");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("origin must be https (http only on loopback)");
  }
}

// Pure option objects: one authorization server per request origin, so
// production, previews, and localhost each get a correct issuer without
// any configured URLs.
export function authServerOptions<Env>(origin: string): OAuthAuthorizationServerOptions<Env> {
  checkOrigin(origin);
  const resource = mcpResourceUrl(origin);
  return {
    issuer: origin,
    resources: [resource],
    defaultResource: resource,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    scopesSupported: [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN, MCP_OAUTH_SCOPE_OFFLINE],
  };
}

export function resourceServerConfig(origin: string): {
  resource: string;
  resourceName: string;
  authorizationServers: string[];
  requiredScopes: string[];
} {
  checkOrigin(origin);
  return {
    resource: mcpResourceUrl(origin),
    resourceName: "Flare Actions MCP",
    authorizationServers: [origin],
    requiredScopes: [MCP_OAUTH_SCOPE_READ],
  };
}

// Dual-auth fallback: a Bearer [REDACTED] the authorization server does not
// recognize is checked against the legacy API tokens (env secrets, then
// D1). OAuth and API tokens converge on one principal shape downstream.
export async function principalFromApiToken(
  token: string,
  secrets: { db: Db; adminToken?: string; runnerToken?: string },
  resource: string,
): Promise<{ props: McpPrincipalProps; audience: string; scope: string[] } | null> {
  const ident = await authIdentityFromToken(token, secrets);
  if (!ident) return null;
  const scope =
    ident.scope === "admin" || ident.scope === "runner"
      ? [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN]
      : [MCP_OAUTH_SCOPE_READ];
  return { props: { actor: ident.actor, repos: ident.repos }, audience: resource, scope };
}

export function canWriteFromScope(scope: string[]): boolean {
  return scope.includes(MCP_OAUTH_SCOPE_RUN);
}

export function principalFromCtx(ctx: { props: McpPrincipalProps; auth: { scope: string[] } }): {
  props: McpPrincipalProps;
  canWrite: boolean;
} {
  return { props: ctx.props, canWrite: canWriteFromScope(ctx.auth.scope) };
}

// Dashboard sessions map onto MCP principals for same-origin browser
// callers (the Cloudflare Site MCP Server pack, native page tools):
// admins read and write, everyone else reads — mirroring authIdentity.
export function principalFromSession(session: OAuthSession): {
  props: McpPrincipalProps;
  canWrite: boolean;
} {
  return {
    props: { actor: session.actor, repos: [] },
    canWrite: session.isAdmin,
  };
}

// Consent grants the requested scopes capped by role: admins may grant
// read+run, everyone else read-only (mirroring dashboard privilege).
// Unknown scopes are dropped, never granted.
export function grantedScope(requested: string[], isAdmin: boolean): string[] {
  const max = isAdmin ? [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_RUN] : [MCP_OAUTH_SCOPE_READ];
  const out = requested.filter((s) => max.includes(s));
  if (requested.includes(MCP_OAUTH_SCOPE_OFFLINE)) out.push(MCP_OAUTH_SCOPE_OFFLINE);
  return [...new Set(out)];
}

export interface OAuthSession {
  userId: string;
  login: string;
  // Audit actor in authIdentity format (kind:login).
  actor: string;
  isAdmin: boolean;
}

// Minimal authorization API the consent handlers need; the provider's
// OAuthHelpers satisfies it structurally, and tests fake it.
export interface AuthorizeApi {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  completeAuthorization(options: CompleteAuthorizationOptions): Promise<{ redirectTo: string }>;
}

export interface AuthorizeContext {
  api: AuthorizeApi;
  session: OAuthSession | null;
  audit: (action: string, target: string) => Promise<void>;
}

function page(title: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}` +
      `.card{border:1px solid #ddd;border-radius:.5rem;padding:1.5rem}.muted{color:#555}button{font-size:1rem;padding:.5rem 1.25rem;margin:.5rem .5rem 0 0;cursor:pointer}` +
      `.allow{background:#111;color:#fff;border:1px solid #111;border-radius:.375rem}.deny{background:#fff;border:1px solid #999;border-radius:.375rem}` +
      `ul{padding-left:1.25rem}li{margin:.25rem 0}</style></head><body><div class="card">${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function oauthErrorPage(message: string): Response {
  return page("Flare Actions", `<h1>Something went wrong</h1><p>${escapeHtml(message)}</p><p class="muted">You can close this tab.</p>`);
}

function loginRequiredPage(): Response {
  return page(
    "Log in to Flare Actions",
    `<h1>Log in to continue</h1><p>An app is asking to connect to Flare Actions. Log in to the ` +
      `<a href="/dashboard">dashboard</a> first, then come back here and reload this page.</p>`,
  );
}

function consentPage(client: ClientInfo, scope: string[], login: string, action: string): Response {
  const scopes = scope
    .map((s) => `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(MCP_OAUTH_SCOPE_DESCRIPTIONS[s] ?? "Unknown scope")}</li>`)
    .join("");
  const name = escapeHtml(client.clientName ?? "An app");
  const uri = client.clientUri ? ` (<a href="${escapeHtml(client.clientUri)}">${escapeHtml(client.clientUri)}</a>)` : "";
  return page(
    "Authorize app",
    `<h1>Authorize ${name}?</h1><p>${name}${uri} wants to connect to Flare Actions as <strong>${escapeHtml(login)}</strong> with:</p>` +
      `<ul>${scopes}</ul>` +
      `<form method="post" action="${escapeHtml(action)}"><button class="allow" type="submit" name="decision" value="allow">Allow</button>` +
      `<button class="deny" type="submit" name="decision" value="deny">Deny</button></form>`,
  );
}

// Error responses redirect back to the client only when the redirect URI
// is one the client registered; otherwise there is no safe place to go.
export function denyRedirect(client: ClientInfo, authRequest: AuthRequest): string | null {
  if (!client.redirectUris.includes(authRequest.redirectUri)) return null;
  const url = new URL(authRequest.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "The user denied the authorization request.");
  if (authRequest.state) url.searchParams.set("state", authRequest.state);
  if (authRequest.issuer) url.searchParams.set("iss", authRequest.issuer);
  return url.toString();
}

async function parseRequest(api: AuthorizeApi, request: Request): Promise<{ authRequest: AuthRequest; client: ClientInfo } | Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch {
    return oauthErrorPage("This authorization link is invalid or expired. Restart the connection from your app.");
  }
  const client = await api.lookupClient(authRequest.clientId).catch(() => null);
  if (!client) return oauthErrorPage("Unknown app. Restart the connection from your app.");
  return { authRequest, client };
}

export async function handleAuthorizeGet(request: Request, ctx: AuthorizeContext): Promise<Response> {
  const parsed = await parseRequest(ctx.api, request);
  if (parsed instanceof Response) return parsed;
  if (!ctx.session) return loginRequiredPage();
  const url = new URL(request.url);
  return consentPage(parsed.client, parsed.authRequest.scope, ctx.session.login, `${url.pathname}${url.search}`);
}

export async function handleAuthorizePost(request: Request, ctx: AuthorizeContext): Promise<Response> {
  const parsed = await parseRequest(ctx.api, request);
  if (parsed instanceof Response) return parsed;
  const { authRequest, client } = parsed;
  if (!ctx.session) return loginRequiredPage();
  let decision: string | null = null;
  try {
    decision = (await request.formData()).get("decision")?.toString() ?? null;
  } catch {
    return oauthErrorPage("Couldn't read the form. Go back and try again.");
  }
  if (decision === "deny") {
    await ctx.audit("oauth.deny", client.clientId).catch(() => undefined);
    const redirect = denyRedirect(client, authRequest);
    if (!redirect) return oauthErrorPage("Not approved, and the app's redirect address is unknown — nothing was granted.");
    return Response.redirect(redirect, 302);
  }
  if (decision !== "allow") return oauthErrorPage("Choose Allow or Deny.");
  const scope = grantedScope(authRequest.scope, ctx.session.isAdmin);
  if (!scope.includes(MCP_OAUTH_SCOPE_READ)) {
    return oauthErrorPage("Your account can only grant read access, and this app asked for nothing you can grant.");
  }
  try {
    const { redirectTo } = await ctx.api.completeAuthorization({
      request: authRequest,
      userId: ctx.session.userId,
      metadata: { login: ctx.session.login, role: ctx.session.isAdmin ? "admin" : "user", clientName: client.clientName ?? null },
      scope,
      props: oauthProps(ctx.session.login),
    });
    await ctx.audit("oauth.grant", `${client.clientId} ${scope.join(",")}`).catch(() => undefined);
    return Response.redirect(redirectTo, 302);
  } catch {
    return oauthErrorPage("Couldn't complete the authorization. Restart the connection from your app.");
  }
}

// Stored grant records, read back for the admin authorized-apps list.
// Corrupt or foreign rows are skipped, never surfaced.
export interface OAuthGrantInfo {
  grantId: string;
  userId: string;
  clientId: string;
  scope: string[];
  createdAt: number | null;
}

export function parseGrantRecord(key: string, value: unknown): OAuthGrantInfo | null {
  if (!key.startsWith("grant:")) return null;
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.userId !== "string" || typeof rec.clientId !== "string") return null;
  if (!Array.isArray(rec.scope) || !rec.scope.every((s): s is string => typeof s === "string")) return null;
  return {
    grantId: rec.id,
    userId: rec.userId,
    clientId: rec.clientId,
    scope: rec.scope,
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : null,
  };
}

export async function listOAuthGrants(
  kv: D1KV,
  options?: { limit?: number; cursor?: string },
): Promise<{ grants: OAuthGrantInfo[]; cursor?: string; list_complete: boolean }> {
  const limit = Math.min(100, Math.max(1, Math.floor(options?.limit ?? 100)));
  const page = await kv.list({ prefix: "grant:", limit, cursor: options?.cursor });
  const grants: OAuthGrantInfo[] = [];
  for (const key of page.keys) {
    // Content validation decides: foreign or corrupt rows under the
    // prefix fail parseGrantRecord and are skipped.
    const value = await kv.get(key.name, { type: "json" });
    const grant = parseGrantRecord(key.name, value);
    if (grant) grants.push(grant);
  }
  return page.list_complete
    ? { grants, list_complete: true }
    : { grants, cursor: page.cursor, list_complete: false };
}
