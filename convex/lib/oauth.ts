// Connecting Gmail, Outlook or GitHub to an account with OAuth 2.0
// (convex/connectors.ts): where to send the person, trading the code the
// service sends back for tokens, renewing them, and handing them back. Plain
// functions over fetch, so tests run them (tests/unit/connectors.test.mjs).
// No imports: the tests load this file straight into Node.

type Fetch = typeof fetch;

export type Service = "gmail" | "outlook" | "github";

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token stops working (ms); none for tokens that don't expire (GitHub). */
  expiresAt?: number;
  scopes: string[];
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/** The service turned the request down: `code` is its error code (invalid_grant…). */
export class OAuthError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

interface ServiceConfig {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  params: Record<string, string>;
}

export const SERVICES: Record<Service, ServiceConfig> = {
  gmail: {
    label: "Gmail",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Gmail's full access: reading, sending, and deleting, to Trash or for good.
    // (gmail.modify can't delete for good; this is the one scope that can.)
    scopes: ["openid", "email", "https://mail.google.com/"],
    pkce: true,
    // A refresh token every time, so the connection lasts.
    params: { access_type: "offline", prompt: "consent" },
  },
  outlook: {
    label: "Outlook",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Mail.ReadWrite: reading, and moving or deleting email.
    scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
    pkce: true,
    params: { response_mode: "query", prompt: "select_account" },
  },
  github: {
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "delete_repo", "workflow", "read:user"],
    pkce: false,
    params: { allow_signup: "false" },
  },
};

export const SERVICE_NAMES = Object.keys(SERVICES) as Service[];

/** The deployment variables that hold each service's OAuth app (CONVEX.md). */
export const APP_VARIABLES: Record<Service, [string, string]> = {
  gmail: ["CONNECT_GOOGLE_ID", "CONNECT_GOOGLE_SECRET"],
  outlook: ["CONNECT_MICROSOFT_ID", "CONNECT_MICROSOFT_SECRET"],
  github: ["CONNECT_GITHUB_ID", "CONNECT_GITHUB_SECRET"],
};

/**
 * The OAuth app a service is connected through, from the deployment's
 * variables, or null while it isn't set up. Gmail can use the sign-in
 * client's ID and secret, but only once they're set as CONNECT_GOOGLE_*: that
 * is the sign that its Gmail access and address back are set up at Google,
 * so Connect never leads to an error page.
 */
export function oauthApp(service: Service, env: Record<string, string | undefined>): OAuthApp | null {
  const [id, secret] = APP_VARIABLES[service];
  const clientId = env[id]?.trim() ?? "";
  const clientSecret = env[secret]?.trim() ?? "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random, URL-safe secret (state, PKCE verifier, claim). */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE challenge for a verifier (S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Where to send the person to approve the connection. */
export function authorizeUrl(service: Service, o: { clientId: string; redirectUri: string; state: string; challenge?: string }): string {
  const c = SERVICES[service];
  const url = new URL(c.authorizeUrl);
  const params: Record<string, string> = {
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: c.scopes.join(" "),
    state: o.state,
    ...c.params,
  };
  if (c.pkce && o.challenge) {
    params.code_challenge = o.challenge;
    params.code_challenge_method = "S256";
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(service: Service, form: Record<string, string>, f: Fetch): Promise<Tokens> {
  const res = await f(SERVICES[service].tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || data?.error || !data?.access_token) {
    throw new OAuthError(String(data?.error_description || data?.error || `HTTP ${res.status}`), String(data?.error || ""));
  }
  return {
    accessToken: String(data.access_token),
    ...(data.refresh_token ? { refreshToken: String(data.refresh_token) } : {}),
    ...(data.expires_in ? { expiresAt: Date.now() + Number(data.expires_in) * 1000 } : {}),
    scopes: String(data.scope ?? "").split(/[,\s]+/).filter(Boolean),
  };
}

/** Trades the code a service sent back for tokens. */
export function exchangeCode(service: Service, o: { app: OAuthApp; code: string; redirectUri: string; verifier?: string; fetch?: Fetch }): Promise<Tokens> {
  return tokenRequest(
    service,
    {
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: o.app.clientId,
      client_secret: o.app.clientSecret,
      ...(SERVICES[service].pkce && o.verifier ? { code_verifier: o.verifier } : {}),
    },
    o.fetch ?? fetch,
  );
}

/** New tokens for old ones (Gmail and Outlook access tokens last about an hour). */
export async function refreshTokens(service: Service, o: { app: OAuthApp; tokens: Tokens; fetch?: Fetch }): Promise<Tokens> {
  if (!o.tokens.refreshToken) throw new OAuthError("The connection has no refresh token", "invalid_grant");
  const fresh = await tokenRequest(
    service,
    {
      grant_type: "refresh_token",
      refresh_token: o.tokens.refreshToken,
      client_id: o.app.clientId,
      client_secret: o.app.clientSecret,
      // Microsoft wants the scopes named again: the ones this connection was
      // granted, so one made before Holly Bot asked for more keeps working.
      ...(service === "outlook" ? { scope: outlookScope(o.tokens.scopes) } : {}),
    },
    o.fetch ?? fetch,
  );
  // Google keeps the refresh token; Microsoft hands out a new one each time.
  return { ...fresh, refreshToken: fresh.refreshToken ?? o.tokens.refreshToken, scopes: fresh.scopes.length ? fresh.scopes : o.tokens.scopes };
}

function outlookScope(granted: string[]): string {
  if (!granted.length) return SERVICES.outlook.scopes.join(" ");
  return [...new Set([...granted, "offline_access"])].join(" ");
}

/**
 * Takes the access back from the service where it can be, when the person
 * disconnects or deletes their account. Google ends Holly Bot's whole grant
 * to that mailbox; GitHub ends just this token. Microsoft has no such
 * endpoint for one app: its tokens simply stop being renewed.
 */
export async function revokeTokens(service: Service, o: { app: OAuthApp | null; tokens: Tokens; fetch?: Fetch }): Promise<void> {
  const f = o.fetch ?? fetch;
  if (service === "gmail") {
    await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(o.tokens.refreshToken ?? o.tokens.accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } else if (service === "github" && o.app) {
    await f(`https://api.github.com/applications/${encodeURIComponent(o.app.clientId)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${o.app.clientId}:${o.app.clientSecret}`)}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Holly-Bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: o.tokens.accessToken }),
    });
  }
}

/** Permissions bots need that a connection lacks: unticked on the service's
 * consent screen, or granted before Holly Bot asked for them (Gmail and
 * Outlook connected before bots could delete email). */
export function missingScopes(service: Service, granted: string[]): string[] {
  const have = new Set(granted.map((s) => s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, "")));
  const need =
    service === "gmail"
      ? ["https://mail.google.com/"]
      : service === "outlook"
        ? ["mail.readwrite", "mail.send"]
        : ["repo"];
  // A service that doesn't list what it granted (some don't on refresh) is taken at its word.
  return have.size ? need.filter((s) => !have.has(s.toLowerCase())) : [];
}
