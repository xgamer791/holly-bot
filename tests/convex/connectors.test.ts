/// <reference types="vite/client" />
// convex/connectors.ts on convex-test's stand-in for the Convex backend, with
// Google, Microsoft and GitHub answering the way their APIs do: connecting
// (consent screen → callback → claim), what bots run, renewing tokens,
// disconnecting and deleting the account, and one account never reaching
// another's. npm run test:convex.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.*s");

const SITE = "https://xgamer791.github.io/holly-bot/";
const CONVEX_SITE = "https://test-deployment.convex.site";
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256)));
const GMAIL_SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

interface Req {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}
type Answer = { status?: number; json?: unknown; headers?: Record<string, string> } | Response;

/** The outside world (Google, Microsoft, GitHub): `answer` handles each request; all are kept. */
function stubServices(answer: (req: Req) => Answer | Promise<Answer>) {
  const calls: Req[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const req: Req = {
      url: new URL(typeof input === "string" || input instanceof URL ? input : input.url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(req);
    const out = await answer(req);
    if (out instanceof Response) return out;
    const status = out.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(out.json ?? {}), { status, headers: { "content-type": "application/json", ...(out.headers ?? {}) } });
  });
  return calls;
}

const form = (req: Req) => Object.fromEntries(new URLSearchParams(req.body));

async function sha256url(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A signed-in account: a user and a live session, called as that session. */
async function signIn(t: ReturnType<typeof convexTest>, email: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
    return { userId, sessionId };
  });
  return { userId, sessionId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

/** Google's side of a Gmail connection: tokens for a code (checking PKCE), renewals, the mailbox. */
function google(opts: { scope?: string; expiresIn?: number; access?: string[] } = {}) {
  const issued = [...(opts.access ?? ["at-1", "at-2", "at-3"])];
  const challenges = new Map<string, string>();
  let valid = new Set<string>();
  let refreshRefused = false;
  const calls = stubServices(async (req) => {
    const host = req.url.host;
    if (host === "oauth2.googleapis.com" && req.url.pathname === "/token") {
      const f = form(req);
      if (f.grant_type === "authorization_code") {
        const challenge = challenges.get(f.code);
        if (!challenge || (await sha256url(f.code_verifier)) !== challenge) return { status: 400, json: { error: "invalid_grant", error_description: "Bad code or verifier." } };
        if (f.redirect_uri !== `${CONVEX_SITE}/connectors/gmail/callback` || f.client_id !== "google-id" || f.client_secret !== "google-secret") return { status: 400, json: { error: "invalid_client" } };
        const at = issued.shift()!;
        valid = new Set([at]);
        return { json: { access_token: at, refresh_token: "rt-1", expires_in: opts.expiresIn ?? 3599, scope: opts.scope ?? GMAIL_SCOPES, token_type: "Bearer" } };
      }
      if (f.grant_type === "refresh_token") {
        if (refreshRefused || f.refresh_token !== "rt-1") return { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
        const at = issued.shift()!;
        valid = new Set([at]);
        return { json: { access_token: at, expires_in: 3599, token_type: "Bearer" } };
      }
    }
    if (host === "oauth2.googleapis.com" && req.url.pathname === "/revoke") return { json: {} };
    if (host === "gmail.googleapis.com") {
      const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
      if (!valid.has(token)) return { status: 401, json: { error: { code: 401, message: "Request had invalid authentication credentials." } } };
      if (req.url.pathname.endsWith("/profile")) return { json: { emailAddress: "me@gmail.com" } };
      if (req.url.pathname.endsWith("/messages")) return { json: { resultSizeEstimate: 0 } };
    }
    return { status: 404, json: { error: { message: `unexpected ${req.method} ${req.url}` } } };
  });
  return {
    calls,
    /** What Google's consent screen does: remember the challenge for a code it hands out. */
    approve(authorizeUrl: string, code = "code-1") {
      const url = new URL(authorizeUrl);
      challenges.set(code, url.searchParams.get("code_challenge")!);
      return { code, state: url.searchParams.get("state")! };
    },
    expire() {
      valid = new Set();
    },
    refuseRefresh() {
      refreshRefused = true;
    },
  };
}

/** GitHub: /user for a token, repositories, and the OAuth app's grant endpoint. */
function githubService() {
  return stubServices((req) => {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (req.url.host === "github.com" && req.url.pathname === "/login/oauth/access_token") {
      return { json: { access_token: "gho_oauthtoken", scope: "repo,delete_repo,workflow,read:user", token_type: "bearer" } };
    }
    if (req.url.pathname.startsWith("/applications/")) return { status: 204 };
    if (!token?.startsWith("gh")) return { status: 401, json: { message: "Bad credentials" } };
    if (req.url.pathname === "/user") return { json: { login: "octo", name: "Octo" }, headers: { "x-oauth-scopes": "repo, delete_repo, workflow" } };
    if (req.url.pathname === "/user/repos") return { json: [{ full_name: "octo/app", private: true, default_branch: "main", html_url: "https://github.com/octo/app" }] };
    return { status: 404, json: { message: "Not Found" } };
  });
}

let t: ReturnType<typeof convexTest>;
beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", CONVEX_SITE);
  vi.stubEnv("SITE_URL", "https://xgamer791.github.io/holly-bot");
  vi.stubEnv("CONNECTORS_KEY", KEY);
  vi.stubEnv("CONNECT_GOOGLE_ID", "google-id");
  vi.stubEnv("CONNECT_GOOGLE_SECRET", "google-secret");
  vi.stubEnv("CONNECT_GITHUB_ID", "github-id");
  vi.stubEnv("CONNECT_GITHUB_SECRET", "github-secret");
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs what was scheduled (revoking tokens that left the database). */
async function drainScheduled() {
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
}

/** Starts connecting Gmail and comes back through the callback: the address the app is sent back to. */
async function connectGmail(as: Awaited<ReturnType<typeof signIn>>["as"], g: ReturnType<typeof google>) {
  const authorize = await as.action(api.connectors.start, { service: "gmail", returnTo: SITE });
  const { code, state } = g.approve(authorize);
  const res = await t.fetch(`/connectors/gmail/callback?state=${encodeURIComponent(state)}&code=${code}&scope=x`, { method: "GET" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe("what can be connected", () => {
  test("follows the deployment's variables", async () => {
    expect(await t.query(api.connectors.available, {})).toEqual({ gmail: true, outlook: false, github: true, githubToken: true });
    vi.stubEnv("CONNECTORS_KEY", "");
    expect(await t.query(api.connectors.available, {})).toEqual({ gmail: false, outlook: false, github: false, githubToken: false });
    vi.stubEnv("CONNECTORS_KEY", KEY);
    vi.stubEnv("CONNECT_MICROSOFT_ID", "ms-id");
    vi.stubEnv("CONNECT_MICROSOFT_SECRET", "ms-secret");
    expect((await t.query(api.connectors.available, {})).outlook).toBe(true);
  });

  test("nothing works signed out", async () => {
    await expect(t.query(api.connectors.list, {})).rejects.toThrow(/Not signed in/);
    await expect(t.action(api.connectors.start, { service: "gmail", returnTo: SITE })).rejects.toThrow(/Not signed in/);
    await expect(t.action(api.connectors.run, { service: "gmail", op: "search", args: {} })).rejects.toThrow(/Not signed in/);
    await expect(t.action(api.connectors.connectToken, { token: `ghp_${"a".repeat(36)}` })).rejects.toThrow(/Not signed in/);
    await expect(t.mutation(api.connectors.claim, { claim: "x" })).rejects.toThrow(/Not signed in/);
    // A session that ended (signed out, account deleted) no longer counts.
    const { as, sessionId } = await signIn(t, "a@example.com");
    await t.run(async (ctx) => ctx.db.delete(sessionId));
    await expect(as.query(api.connectors.list, {})).rejects.toThrow(/Not signed in/);
  });
});

describe("Gmail", () => {
  test("connects through Google's consent screen and joins the account only when its app claims it", async () => {
    const g = google();
    const { as, userId } = await signIn(t, "a@example.com");
    const authorize = new URL(await as.action(api.connectors.start, { service: "gmail", returnTo: SITE }));
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("client_id")).toBe("google-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${CONVEX_SITE}/connectors/gmail/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const { code, state } = g.approve(authorize.toString());

    const res = await t.fetch(`/connectors/gmail/callback?state=${state}&code=${code}`, { method: "GET" });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(SITE);
    const claim = back.searchParams.get("connect")!;
    expect(claim).toMatch(/^[\w-]{43}$/);
    expect(back.searchParams.get("connect_error")).toBeNull();

    // Not in the account until claimed.
    expect(await as.query(api.connectors.list, {})).toEqual([]);
    expect(await as.mutation(api.connectors.claim, { claim })).toEqual({ service: "gmail", account: "me@gmail.com" });
    const list = await as.query(api.connectors.list, {});
    expect(list).toMatchObject([{ service: "gmail", account: "me@gmail.com", via: "oauth" }]);
    expect(Object.keys(list[0]).sort()).toEqual(["account", "connectedAt", "service", "via"]);

    // The tokens are sealed at rest.
    const rows = await t.run((ctx) => ctx.db.query("connections").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].sealed).toMatch(/^v1\./);
    expect(rows[0].sealed).not.toContain("at-1");
    expect(rows[0].sealed).not.toContain("rt-1");
    expect(await t.run((ctx) => ctx.db.query("connectorStates").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toEqual([]);

    // A state and a claim work once.
    expect((await t.fetch(`/connectors/gmail/callback?state=${state}&code=${code}`, { method: "GET" })).status).toBe(400);
    expect(await as.mutation(api.connectors.claim, { claim })).toEqual({ error: "That connection has expired. Connect it again." });

    // Bots use it, with the token Google issued.
    expect(await as.action(api.connectors.run, { service: "gmail", op: "search", args: { query: "is:unread" } })).toEqual([]);
    const search = g.calls.at(-1)!;
    expect(search.url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(search.url.searchParams.get("q")).toBe("is:unread");
    expect(search.headers.get("authorization")).toBe("Bearer at-1");
  });

  test("a connection started by one account can't be claimed by another, and a refused claim is thrown away", async () => {
    const g = google();
    const a = await signIn(t, "a@example.com");
    const b = await signIn(t, "b@example.com");
    const back = await connectGmail(a.as, g);
    const claim = back.searchParams.get("connect")!;
    expect(await b.as.mutation(api.connectors.claim, { claim })).toEqual({ error: "That connection was started from another Holly Bot account, so it wasn't added to this one." });
    expect(await b.as.query(api.connectors.list, {})).toEqual([]);
    // Thrown away with its tokens: a claim that leaked is no use to anyone.
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toEqual([]);
    expect(await a.as.mutation(api.connectors.claim, { claim })).toEqual({ error: "That connection has expired. Connect it again." });
    expect(await a.as.query(api.connectors.list, {})).toEqual([]);
    // Not revoked: at Google that would end a connection of the same mailbox that works.
    expect(g.calls.some((c) => c.url.pathname === "/revoke")).toBe(false);
  });

  test("connections never finished are swept away", async () => {
    const g = google();
    const { as } = await signIn(t, "a@example.com");
    await connectGmail(as, g); // approved, never claimed
    await as.action(api.connectors.start, { service: "github", returnTo: SITE }); // never approved
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("connectorStates").collect())).toHaveLength(1);
    await t.mutation(internal.connectors.sweep, {});
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toHaveLength(1);
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
    await t.mutation(internal.connectors.sweep, {});
    vi.useRealTimers();
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connectorStates").collect())).toEqual([]);
  });

  test("cancelling, unticked permissions and stale links come back as errors the app can show", async () => {
    const g = google({ scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
    const { as } = await signIn(t, "a@example.com");
    const cancelled = new URL(await as.action(api.connectors.start, { service: "gmail", returnTo: SITE }));
    const res = await t.fetch(`/connectors/gmail/callback?state=${cancelled.searchParams.get("state")}&error=access_denied`, { method: "GET" });
    const back = new URL(res.headers.get("location")!);
    expect(Object.fromEntries(back.searchParams)).toEqual({ connect_error: "cancelled", service: "gmail" });

    const partial = await connectGmail(as, g);
    expect(Object.fromEntries(partial.searchParams)).toEqual({ connect_error: "permissions", service: "gmail" });
    expect(await as.query(api.connectors.list, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("connectorClaims").collect())).toEqual([]);

    const unknown = await t.fetch(`/connectors/gmail/callback?state=nope&code=x`, { method: "GET" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/expired/);
    // A state started for one service doesn't finish another.
    const started = new URL(await as.action(api.connectors.start, { service: "gmail", returnTo: SITE }));
    expect((await t.fetch(`/connectors/github/callback?state=${started.searchParams.get("state")}&code=x`, { method: "GET" })).status).toBe(400);
    expect((await t.fetch(`/connectors/../gmail/callback?state=x`, { method: "GET" })).status).toBeGreaterThanOrEqual(400);
  });

  test("only comes back to Holly Bot, and only for services that are set up", async () => {
    const { as } = await signIn(t, "a@example.com");
    await expect(as.action(api.connectors.start, { service: "gmail", returnTo: "https://evil.example/" })).rejects.toThrow(/can't come back/);
    await expect(as.action(api.connectors.start, { service: "gmail", returnTo: "https://xgamer791.github.io/holly-bot.evil.example/" })).rejects.toThrow(/can't come back/);
    await expect(as.action(api.connectors.start, { service: "outlook", returnTo: SITE })).rejects.toThrow(/isn't set up/);
    expect(await as.action(api.connectors.start, { service: "gmail", returnTo: "http://localhost:8080/" })).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  test("renews an expiring token, retries once when Google turns one down, and asks to reconnect when renewing fails", async () => {
    const g = google({ expiresIn: 30, access: ["at-1", "at-2", "at-3", "at-4"] });
    const { as } = await signIn(t, "a@example.com");
    const back = await connectGmail(as, g);
    await as.mutation(api.connectors.claim, { claim: back.searchParams.get("connect")! });
    const before = (await t.run((ctx) => ctx.db.query("connections").collect()))[0].sealed;

    // Less than a minute left: renewed first.
    await as.action(api.connectors.run, { service: "gmail", op: "search", args: {} });
    const refresh = g.calls.filter((c) => c.url.pathname === "/token" && form(c).grant_type === "refresh_token");
    expect(refresh).toHaveLength(1);
    expect(form(refresh[0])).toMatchObject({ refresh_token: "rt-1", client_id: "google-id", client_secret: "google-secret" });
    expect(g.calls.at(-1)!.headers.get("authorization")).toBe("Bearer at-2");
    expect((await t.run((ctx) => ctx.db.query("connections").collect()))[0].sealed).not.toBe(before);

    // Turned down mid-life (revoked elsewhere, clock skew): renewed and retried once.
    g.expire();
    await as.action(api.connectors.run, { service: "gmail", op: "search", args: {} });
    expect(g.calls.at(-1)!.headers.get("authorization")).toBe("Bearer at-3");

    // The person took Holly Bot's access away at Google: connect again.
    g.expire();
    g.refuseRefresh();
    await expect(as.action(api.connectors.run, { service: "gmail", op: "search", args: {} })).rejects.toThrow(/Gmail needs connecting again/);
  });

  test("disconnecting removes it and gives the access back to Google", async () => {
    const g = google();
    const { as } = await signIn(t, "a@example.com");
    await as.mutation(api.connectors.claim, { claim: (await connectGmail(as, g)).searchParams.get("connect")! });
    await as.action(api.connectors.disconnect, { service: "gmail" });
    expect(await as.query(api.connectors.list, {})).toEqual([]);
    expect(g.calls.find((c) => c.url.pathname === "/revoke")?.url.searchParams.get("token")).toBe("rt-1");
    await expect(as.action(api.connectors.run, { service: "gmail", op: "search", args: {} })).rejects.toThrow(/isn't connected/);
  });
});

describe("Outlook", () => {
  test("connects through Microsoft, sends and replies, and keeps the refresh token Microsoft rotates", async () => {
    vi.stubEnv("CONNECT_MICROSOFT_ID", "ms-id");
    vi.stubEnv("CONNECT_MICROSOFT_SECRET", "ms-secret");
    const challenges = new Map<string, string>();
    let issued = 0;
    let refreshToken = "";
    const calls = stubServices(async (req) => {
      if (req.url.host === "login.microsoftonline.com") {
        const f = form(req);
        expect(req.url.pathname).toBe("/common/oauth2/v2.0/token");
        if (f.grant_type === "authorization_code") {
          if ((await sha256url(f.code_verifier)) !== challenges.get(f.code)) return { status: 400, json: { error: "invalid_grant" } };
        } else if (f.refresh_token !== refreshToken || f.scope !== "offline_access User.Read Mail.Read Mail.Send") {
          return { status: 400, json: { error: "invalid_grant" } };
        }
        issued++;
        refreshToken = `mrt-${issued}`;
        return { json: { access_token: `mat-${issued}`, refresh_token: refreshToken, expires_in: issued === 1 ? 10 : 3600, scope: "Mail.Read Mail.Send User.Read openid profile email" } };
      }
      if (req.url.host === "graph.microsoft.com") {
        if (req.headers.get("authorization") !== `Bearer mat-${issued}`) return { status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } } };
        if (req.url.pathname === "/v1.0/me") return { json: { mail: null, userPrincipalName: "sam@outlook.com" } };
        if (req.url.pathname === "/v1.0/me/sendMail" || req.url.pathname.endsWith("/reply")) return { status: 202, json: {} };
      }
      return { status: 404, json: { error: { message: `unexpected ${req.url}` } } };
    });
    const { as } = await signIn(t, "a@example.com");
    const authorize = new URL(await as.action(api.connectors.start, { service: "outlook", returnTo: SITE }));
    expect(authorize.origin + authorize.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    challenges.set("ms-code", authorize.searchParams.get("code_challenge")!);
    const res = await t.fetch(`/connectors/outlook/callback?state=${authorize.searchParams.get("state")}&code=ms-code&session_state=x`, { method: "GET" });
    const claim = new URL(res.headers.get("location")!).searchParams.get("connect")!;
    expect(await as.mutation(api.connectors.claim, { claim })).toEqual({ service: "outlook", account: "sam@outlook.com" });

    // The first token is about to run out: renewed with Microsoft's new refresh token, then sent.
    expect(await as.action(api.connectors.run, { service: "outlook", op: "send", args: { to: ["anna@contoso.com"], subject: "Hi", body: "Hello" } })).toEqual({ sent: true, to: ["anna@contoso.com"], cc: [], bcc: [], subject: "Hi" });
    const send = calls.find((c) => c.url.pathname === "/v1.0/me/sendMail")!;
    expect(send.headers.get("authorization")).toBe("Bearer mat-2");
    expect(JSON.parse(send.body).message.toRecipients).toEqual([{ emailAddress: { address: "anna@contoso.com" } }]);
    // The rotated refresh token was kept: the next renewal (a 401) works.
    issued++; // Microsoft's side moves on: the held access token is no longer good
    refreshToken = "mrt-2";
    await as.action(api.connectors.run, { service: "outlook", op: "send", args: { replyTo: "AAMk=", body: "Thanks" } });
    const reply = calls.filter((c) => c.url.pathname.endsWith("/reply")).at(-1)!;
    expect(reply.url.pathname).toBe("/v1.0/me/messages/AAMk%3D/reply");
    expect(JSON.parse(reply.body)).toEqual({ comment: "Thanks" });
  });
});

describe("GitHub", () => {
  const token = `ghp_${"A1b2".repeat(9)}`;

  test("connects with a token the person made, checked with GitHub first", async () => {
    const calls = githubService();
    const { as } = await signIn(t, "a@example.com");
    await expect(as.action(api.connectors.connectToken, { token: "hunter2" })).rejects.toThrow(/doesn't look like a GitHub token/);
    await expect(as.action(api.connectors.connectToken, { token: `ghp_${"x".repeat(10)}` })).rejects.toThrow(/doesn't look like/);
    expect(calls).toHaveLength(0);
    expect(await as.action(api.connectors.connectToken, { token: ` ${token}\n` })).toEqual({ service: "github", account: "octo" });
    expect(await as.query(api.connectors.list, {})).toMatchObject([{ service: "github", account: "octo", via: "token" }]);
    const repos = await as.action(api.connectors.run, { service: "github", op: "list_repos", args: {} });
    expect(repos).toMatchObject([{ repo: "octo/app", private: true }]);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${token}`);
    const rows = await t.run((ctx) => ctx.db.query("connections").collect());
    expect(rows[0].sealed).not.toContain(token);
    expect(rows[0].scopes).toEqual(["repo", "delete_repo", "workflow"]);

    // Disconnecting a token the person made leaves revoking it to them.
    await as.action(api.connectors.disconnect, { service: "github" });
    expect(calls.some((c) => c.url.pathname.startsWith("/applications/"))).toBe(false);
    expect(await as.query(api.connectors.list, {})).toEqual([]);
  });

  test("a token GitHub turns down is not kept", async () => {
    stubServices(() => ({ status: 401, json: { message: "Bad credentials" } }));
    const { as } = await signIn(t, "a@example.com");
    await expect(as.action(api.connectors.connectToken, { token })).rejects.toThrow(/didn't accept that token/);
    expect(await as.query(api.connectors.list, {})).toEqual([]);
  });

  test("connects through a GitHub OAuth app, and disconnecting takes the grant back", async () => {
    const calls = githubService();
    const { as } = await signIn(t, "a@example.com");
    const authorize = new URL(await as.action(api.connectors.start, { service: "github", returnTo: SITE }));
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    const res = await t.fetch(`/connectors/github/callback?state=${authorize.searchParams.get("state")}&code=gh-code`, { method: "GET" });
    const claim = new URL(res.headers.get("location")!).searchParams.get("connect")!;
    expect(await as.mutation(api.connectors.claim, { claim })).toEqual({ service: "github", account: "octo" });
    const exchange = calls.find((c) => c.url.pathname === "/login/oauth/access_token")!;
    expect(form(exchange)).toMatchObject({ code: "gh-code", client_id: "github-id", client_secret: "github-secret", redirect_uri: `${CONVEX_SITE}/connectors/github/callback` });
    await as.action(api.connectors.disconnect, { service: "github" });
    const revoke = calls.find((c) => c.url.pathname === "/applications/github-id/token")!;
    expect(revoke.method).toBe("DELETE");
    expect(revoke.headers.get("authorization")).toBe(`Basic ${btoa("github-id:github-secret")}`);
    expect(JSON.parse(revoke.body)).toEqual({ access_token: "gho_oauthtoken" });
  });

  test("bots can only run the operations there are", async () => {
    githubService();
    const { as } = await signIn(t, "a@example.com");
    await as.action(api.connectors.connectToken, { token });
    for (const op of ["constructor", "__proto__", "toString", "exec"]) {
      await expect(as.action(api.connectors.run, { service: "github", op, args: {} })).rejects.toThrow(/has no/);
    }
    await expect(as.action(api.connectors.run, { service: "github", op: "read_file", args: { repo: "octo/app", path: "../x" } })).rejects.toThrow(/can't go up/);
    await expect(as.action(api.connectors.run, { service: "github", op: "read_file", args: { repo: "octo/app", path: "missing.txt" } })).rejects.toThrow(/GitHub couldn't find that/);
  });
});

describe("accounts stay apart", () => {
  test("one account never sees or uses another's connections, even with its sealed tokens", async () => {
    githubService();
    const a = await signIn(t, "a@example.com");
    const b = await signIn(t, "b@example.com");
    await a.as.action(api.connectors.connectToken, { token: `ghp_${"Z9".repeat(18)}` });
    expect(await b.as.query(api.connectors.list, {})).toEqual([]);
    await expect(b.as.action(api.connectors.run, { service: "github", op: "list_repos", args: {} })).rejects.toThrow(/isn't connected/);
    // A's sealed tokens copied onto a row of B's don't open for B.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("connections").collect())[0];
      await ctx.db.insert("connections", { ...row, _id: undefined, _creationTime: undefined, userId: b.userId } as never);
    });
    await expect(b.as.action(api.connectors.run, { service: "github", op: "list_repos", args: {} })).rejects.toThrow(/needs connecting again/);
    // Disconnecting in B doesn't touch A.
    await b.as.action(api.connectors.disconnect, { service: "github" });
    expect(await a.as.query(api.connectors.list, {})).toMatchObject([{ service: "github", account: "octo" }]);
  });

  test("deleting the account removes its connections and gives Google its access back", async () => {
    const g = google();
    const a = await signIn(t, "a@example.com");
    await a.as.mutation(api.connectors.claim, { claim: (await connectGmail(a.as, g)).searchParams.get("connect")! });
    await a.as.action(api.connectors.start, { service: "gmail", returnTo: SITE }); // left unfinished
    const other = await signIn(t, "b@example.com");
    await other.as.action(api.connectors.start, { service: "gmail", returnTo: SITE });
    let done = false;
    for (let i = 0; i < 20 && !done; i++) ({ done } = await a.as.mutation(api.account.deleteAccount, {}));
    expect(done).toBe(true);
    const left = await t.run(async (ctx) => ({
      connections: await ctx.db.query("connections").collect(),
      states: await ctx.db.query("connectorStates").collect(),
      claims: await ctx.db.query("connectorClaims").collect(),
    }));
    expect(left.connections).toEqual([]);
    expect(left.claims).toEqual([]);
    expect(left.states.map((s) => s.userId)).toEqual([other.userId]);
    await drainScheduled();
    expect(g.calls.filter((c) => c.url.pathname === "/revoke")).toHaveLength(1);
  });
});
