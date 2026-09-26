import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { isAllowedRedirect } from "./auth";
import { requireUserId } from "./lib/auth";
import { requireSubscriber } from "./lib/subscription";
import * as github from "./lib/github";
import * as higgsfield from "./lib/higgsfield";
import { convexSafe } from "./lib/values";
import * as mail from "./lib/mail";
import {
  OAuthError,
  SERVICES,
  SERVICE_NAMES,
  authorizeUrl,
  exchangeCode,
  missingScopes,
  oauthApp,
  pkceChallenge,
  randomToken,
  refreshTokens,
  registerClient,
  registersClient,
  revokeTokens,
  type OAuthApp,
  type Service,
  type Tokens,
} from "./lib/oauth";
import { seal, unseal } from "./lib/seal";

// Connectors: Gmail, Outlook, GitHub and Higgsfield, connected to an account
// so its bots can read and send email, work on repositories, and make images
// and videos when asked (src/core/tools/connector-tools.js, and Higgsfield's
// own tools: src/core/plugins.js). The tokens stay here, sealed with
// CONNECTORS_KEY; bots ask `run`, which calls the service for them.
//
// Connecting: the app asks `start` for the service's consent screen and goes
// there. The service sends the person back to `callback` (on this deployment's
// site URL) with a code, which is traded for tokens right away; the connection
// then waits as a claim until the app that started it, signed in to the same
// account, claims it. So a consent screen someone else sent you to can't put
// your mailbox in their account. A GitHub token pasted in Settings is checked
// with GitHub and kept the same way (`connectToken`).

const WINDOW_MS = 10 * 60 * 1000;
const service = v.union(v.literal("gmail"), v.literal("outlook"), v.literal("github"), v.literal("higgsfield"));

const env = () => process.env as Record<string, string | undefined>;
const key = () => process.env.CONNECTORS_KEY;
/** What a sealed token is bound to: the account and the service. */
const bound = (userId: string, s: string) => `${userId}:${s}`;
const callbackUrl = (s: Service) => `${process.env.CONVEX_SITE_URL}/connectors/${s}/callback`;
const label = (s: string) => SERVICES[s as Service]?.label ?? s;
/** `why`: the service's own words, when it gave any. */
const reconnect = (s: string, why = "") => new ConvexError(`${label(s)} needs connecting again: Settings → Plugins.${why ? ` (${why.slice(0, 120)})` : ""}`);

/** The OAuth app a connection goes through: the deployment's (CONVEX.md), or,
 * for a service Holly Bot registers with as each connection starts
 * (Higgsfield), the client registered for that connection. */
function appFor(s: Service, tokens?: { clientId?: string }): OAuthApp | null {
  if (registersClient(s)) return tokens?.clientId ? { clientId: tokens.clientId, clientSecret: "" } : null;
  return oauthApp(s, env());
}

/** Which services can be connected on this deployment right now. */
export const available = query({
  args: {},
  returns: v.object({ gmail: v.boolean(), outlook: v.boolean(), github: v.boolean(), githubToken: v.boolean(), higgsfield: v.boolean() }),
  handler: async () => {
    const ready = !!key();
    return {
      gmail: ready && !!oauthApp("gmail", env()),
      outlook: ready && !!oauthApp("outlook", env()),
      github: ready && !!oauthApp("github", env()),
      githubToken: ready,
      // Nothing to set up: Holly Bot registers with Higgsfield as a connection starts.
      higgsfield: ready,
    };
  },
});

/** The account's connections, without their tokens. `outdated`: a Gmail or
 * Outlook connection made before bots could delete email, which needs
 * connecting again for that. */
export const list = query({
  args: {},
  returns: v.array(v.object({ service: v.string(), account: v.string(), via: v.string(), connectedAt: v.number(), outdated: v.boolean() })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db.query("connections").withIndex("by_user_service", (q) => q.eq("userId", userId)).collect();
    return rows.map((row) => ({ service: row.service, account: row.account, via: row.via, connectedAt: row.connectedAt, outdated: outdated(row.service, row.scopes) }));
  },
});

/** A mail connection without the access deleting takes. */
function outdated(s: string, scopes: string[]): boolean {
  return (s === "gmail" || s === "outlook") && missingScopes(s, scopes).length > 0;
}

/** The signed-in account, for the actions below (their sign-in passes to
 * what they run). Connecting a service takes an active subscription. */
export const whoami = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => await requireSubscriber(ctx),
});

/** Starts connecting a service: the address of its consent screen. */
export const start = action({
  args: { service, returnTo: v.string() },
  returns: v.string(),
  handler: async (ctx, { service: s, returnTo }) => {
    await ctx.runQuery(internal.connectors.whoami, {});
    const registers = registersClient(s);
    const app = registers ? null : oauthApp(s, env());
    if ((!registers && !app) || !key()) throw new ConvexError(`${label(s)} isn't set up on Holly Bot's server yet.`);
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holly Bot can't come back to that address.");
    // Higgsfield has no app to set up: Holly Bot registers a client for this connection.
    let clientId = app?.clientId ?? "";
    if (registers) {
      try {
        clientId = await registerClient(s, { redirectUri: callbackUrl(s) });
      } catch (err) {
        console.error(`Registering with ${s} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw new ConvexError("Couldn't reach Higgsfield. Try again in a minute.");
      }
    }
    const state = randomToken();
    const verifier = randomToken(48);
    await ctx.runMutation(internal.connectors.saveState, { service: s, state, verifier, returnTo, ...(registers ? { clientId } : {}) });
    return authorizeUrl(s, { clientId, redirectUri: callbackUrl(s), state, challenge: await pkceChallenge(verifier) });
  },
});

export const saveState = internalMutation({
  args: { service, state: v.string(), verifier: v.string(), returnTo: v.string(), clientId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    // A new attempt replaces an unfinished one for the same service.
    for (const old of await ctx.db.query("connectorStates").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (old.expiresAt < Date.now() || old.service === args.service) await ctx.db.delete(old._id);
    }
    await ctx.db.insert("connectorStates", { userId, ...args, expiresAt: Date.now() + WINDOW_MS });
    return null;
  },
});

/** Spends a state: who started the connection, and how to finish it. */
export const takeState = internalMutation({
  args: { state: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), service: v.string(), verifier: v.string(), returnTo: v.string(), clientId: v.optional(v.string()) })),
  handler: async (ctx, { state }) => {
    const row = await ctx.db.query("connectorStates").withIndex("by_state", (q) => q.eq("state", state)).unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < Date.now()) return null;
    return { userId: row.userId, service: row.service, verifier: row.verifier, returnTo: row.returnTo, ...(row.clientId ? { clientId: row.clientId } : {}) };
  },
});

export const savePending = internalMutation({
  args: { userId: v.id("users"), service, account: v.string(), scopes: v.array(v.string()), sealed: v.string(), claim: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("connectorClaims", { ...args, expiresAt: Date.now() + WINDOW_MS });
    return null;
  },
});

async function identify(s: Service, token: string): Promise<string> {
  if (s === "gmail") return (await mail.gmailProfile({ token })).email;
  if (s === "outlook") return (await mail.outlookProfile({ token })).email;
  if (s === "higgsfield") return await higgsfield.higgsfieldAccount({ token });
  return (await github.githubUser({ token })).login;
}

/** Where the service sends the person back to (convex/http.ts routes /connectors/<service>/callback here). */
export const callback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const s = url.pathname.split("/")[2] as Service;
  const state = url.searchParams.get("state") ?? "";
  const started = state && SERVICE_NAMES.includes(s) ? await ctx.runMutation(internal.connectors.takeState, { state }) : null;
  if (!started || started.service !== s) {
    return new Response("This link has expired. Go back to Holly Bot and connect again.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const back = (params: Record<string, string>) => {
    const to = new URL(started.returnTo);
    for (const [name, value] of Object.entries(params)) to.searchParams.set(name, value);
    return new Response(null, { status: 302, headers: { Location: to.toString(), "Cache-Control": "no-store" } });
  };
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code) return back({ connect_error: error === "access_denied" ? "cancelled" : "failed", service: s });
  const app = appFor(s, started);
  if (!app || !key()) return back({ connect_error: "failed", service: s });
  try {
    const tokens = await exchangeCode(s, { app, code, redirectUri: callbackUrl(s), verifier: started.verifier });
    // Renewing and revoking them later goes through the client they were issued to.
    if (registersClient(s)) tokens.clientId = app.clientId;
    // Permissions unticked: the tokens are dropped, never kept. (Not revoked:
    // at Google that ends the person's whole grant, a connection that works
    // included.)
    if (missingScopes(s, tokens.scopes).length) return back({ connect_error: "permissions", service: s });
    const account = await identify(s, tokens.accessToken);
    const claim = randomToken();
    const sealed = await seal(key(), tokens, bound(started.userId, s));
    await ctx.runMutation(internal.connectors.savePending, { userId: started.userId, service: s, account, scopes: tokens.scopes, sealed, claim });
    return back({ connect: claim });
  } catch (err) {
    console.error(`Connecting ${s} failed: ${err instanceof Error ? err.message : String(err)}`);
    return back({ connect_error: "failed", service: s });
  }
});

async function upsert(ctx: MutationCtx, userId: Id<"users">, s: string, fields: { account: string; scopes: string[]; via: string; sealed: string }) {
  const now = Date.now();
  const existing = await ctx.db
    .query("connections")
    .withIndex("by_user_service", (q) => q.eq("userId", userId).eq("service", s))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { ...fields, updatedAt: now });
  else await ctx.db.insert("connections", { userId, service: s, ...fields, connectedAt: now, updatedAt: now });
}

/**
 * Finishes a connection the service approved, for the account that started
 * it. A claim is used once: one from another account, or too old, is thrown
 * away with its tokens. That's why problems come back as `error` instead of
 * being thrown: a thrown error would undo throwing it away.
 */
export const claim = mutation({
  args: { claim: v.string() },
  returns: v.union(v.object({ service: v.string(), account: v.string() }), v.object({ error: v.string() })),
  handler: async (ctx, { claim }) => {
    const userId = await requireSubscriber(ctx);
    const row = await ctx.db.query("connectorClaims").withIndex("by_claim", (q) => q.eq("claim", claim)).unique();
    if (!row) return { error: "That connection has expired. Connect it again." };
    await ctx.db.delete(row._id);
    if (row.userId !== userId) return { error: "That connection was started from another Holly Bot account, so it wasn't added to this one." };
    if (row.expiresAt < Date.now()) return { error: "That connection has expired. Connect it again." };
    await upsert(ctx, userId, row.service, { account: row.account, scopes: row.scopes, via: "oauth", sealed: row.sealed });
    return { service: row.service, account: row.account };
  },
});

/** Throws away connections that were started but never finished (convex/crons.ts). */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    for (const table of ["connectorStates", "connectorClaims"] as const) {
      const old = await ctx.db.query(table).withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(200);
      for (const row of old) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Connects GitHub with a token the person made (a personal access token). */
export const connectToken = action({
  args: { token: v.string() },
  returns: v.object({ service: v.string(), account: v.string() }),
  handler: async (ctx, { token }) => {
    const userId = await ctx.runQuery(internal.connectors.whoami, {});
    if (!key()) throw new ConvexError("Connections aren't set up on Holly Bot's server yet.");
    const t = token.trim();
    if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) {
      throw new ConvexError("That doesn't look like a GitHub token. They start with github_pat_ or ghp_.");
    }
    let user: { login: string; scopes: string[] };
    try {
      user = await github.githubUser({ token: t });
    } catch (err) {
      throw new ConvexError(err instanceof github.GitHubError && err.status === 401 ? "GitHub didn't accept that token." : "Couldn't reach GitHub. Try again.");
    }
    const tokens: Tokens = { accessToken: t, scopes: user.scopes };
    await ctx.runMutation(internal.connectors.saveMine, {
      service: "github",
      account: user.login,
      scopes: user.scopes,
      via: "token",
      sealed: await seal(key(), tokens, bound(userId, "github")),
    });
    return { service: "github", account: user.login };
  },
});

export const saveMine = internalMutation({
  args: { service, account: v.string(), scopes: v.array(v.string()), via: v.string(), sealed: v.string() },
  returns: v.null(),
  handler: async (ctx, { service: s, ...fields }) => {
    const userId = await requireUserId(ctx);
    await upsert(ctx, userId, s, fields);
    return null;
  },
});

/** Disconnects a service: it leaves the account, and the service takes the access back where it can. */
export const disconnect = action({
  args: { service },
  returns: v.null(),
  handler: async (ctx, { service: s }) => {
    const removed = await ctx.runMutation(internal.connectors.removeMine, { service: s });
    if (removed) await revokeSealed(s, removed.sealed, removed.bound, removed.via).catch((err) => console.warn(`Revoking ${s}: ${err}`));
    return null;
  },
});

export const removeMine = internalMutation({
  args: { service },
  returns: v.union(v.null(), v.object({ sealed: v.string(), via: v.string(), bound: v.string() })),
  handler: async (ctx, { service: s }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.query("connections").withIndex("by_user_service", (q) => q.eq("userId", userId).eq("service", s)).unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return { sealed: row.sealed, via: row.via, bound: bound(userId, s) };
  },
});

async function revokeSealed(s: string, sealed: string, where: string, via: string) {
  // A GitHub token the person made is theirs to revoke on GitHub.
  if (via !== "oauth" || !SERVICE_NAMES.includes(s as Service)) return;
  const tokens = await unseal<Tokens>(key(), sealed, where);
  await revokeTokens(s as Service, { app: appFor(s as Service, tokens), tokens });
}

/** Revokes a connection's tokens after it has left the database (a deleted account). */
export const revokeLater = internalAction({
  args: { service: v.string(), sealed: v.string(), bound: v.string(), via: v.string() },
  returns: v.null(),
  handler: async (_ctx, a) => {
    await revokeSealed(a.service, a.sealed, a.bound, a.via).catch((err) => console.warn(`Revoking ${a.service}: ${err}`));
    return null;
  },
});

/** The account's connection to a service, for a bot's request (`run`), which
 * takes an active subscription. */
export const mine = internalQuery({
  args: { service },
  returns: v.union(v.null(), v.object({ id: v.id("connections"), userId: v.id("users"), sealed: v.string(), scopes: v.array(v.string()) })),
  handler: async (ctx, { service: s }) => {
    const userId = await requireSubscriber(ctx);
    const row = await ctx.db.query("connections").withIndex("by_user_service", (q) => q.eq("userId", userId).eq("service", s)).unique();
    return row ? { id: row._id, userId, sealed: row.sealed, scopes: row.scopes } : null;
  },
});

export const updateTokens = internalMutation({
  args: { id: v.id("connections"), sealed: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, sealed }) => {
    if (await ctx.db.get(id)) await ctx.db.patch(id, { sealed, updatedAt: Date.now() });
    return null;
  },
});

type Op = (api: { token: string }, args: any) => Promise<unknown>;
const OPS: Record<Service, Record<string, Op>> = {
  gmail: { search: mail.gmailSearch, read: mail.gmailRead, send: mail.gmailSend, peek: mail.gmailPeek, delete: mail.gmailDelete, restore: mail.gmailRestore },
  outlook: { search: mail.outlookSearch, read: mail.outlookRead, send: mail.outlookSend, peek: mail.outlookPeek, delete: mail.outlookDelete, restore: mail.outlookRestore },
  github: {
    list_repos: github.listRepos,
    create_repo: github.createRepo,
    update_repo: github.updateRepo,
    delete_repo: github.deleteRepo,
    list_files: github.listFiles,
    read_file: github.readFile,
    write_file: github.writeFile,
    delete_file: github.deleteFile,
    request: github.request,
  },
  // Higgsfield's own MCP server: what it offers, and running one of its tools.
  higgsfield: { tools: higgsfield.listTools, call: higgsfield.callTool },
};

function statusOf(err: unknown): number {
  return err instanceof mail.ApiError || err instanceof github.GitHubError || err instanceof higgsfield.HiggsfieldError ? err.status : 0;
}

/** What went wrong, in words a bot can pass on. */
function asError(s: Service, err: unknown): ConvexError<string> {
  if (err instanceof ConvexError) return err;
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401) return reconnect(s, message);
  if (status === 403) return new ConvexError(`${label(s)} doesn't allow that: ${message}`);
  if (status === 404) return new ConvexError(`${label(s)} couldn't find that: ${message}`);
  if (status === 429) return new ConvexError(`${label(s)} asked to slow down. Try again in a minute.`);
  return new ConvexError(status ? `${label(s)}: ${message}` : message);
}

/** A bot's request to a connected service (src/core/tools/connector-tools.js). */
export const run = action({
  args: { service, op: v.string(), args: v.optional(v.any()) },
  returns: v.any(),
  handler: async (ctx, { service: s, op, args }): Promise<any> => {
    try {
      // In a shape Convex can send back: a field name it won't take (a tool
      // schema's "$defs") would fail the whole call as a bare "Server Error".
      return convexSafe(await runOp(ctx, s, op, args));
    } catch (err) {
      // Nothing gets out as a bare "Server Error": the person reads what went wrong.
      if (!(err instanceof ConvexError)) console.error(`${s} ${op} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      throw asError(s, err);
    }
  },
});

async function runOp(ctx: ActionCtx, s: Service, op: string, args: unknown): Promise<any> {
  const fn = Object.prototype.hasOwnProperty.call(OPS[s], op) ? OPS[s][op] : undefined;
  if (!fn) throw new ConvexError(`${label(s)} has no “${op}”.`);
  const conn: { id: Id<"connections">; userId: Id<"users">; sealed: string; scopes: string[] } | null = await ctx.runQuery(internal.connectors.mine, { service: s });
  if (!conn) throw new ConvexError(`${label(s)} isn't connected. Connect it in Settings → Plugins.`);
  // peek is how a delete starts (its preview), so it says so before anyone is asked to approve.
  if ((op === "peek" || op === "delete" || op === "restore") && outdated(s, conn.scopes)) {
    throw new ConvexError(`${label(s)} was connected before bots could delete email. To let them, connect it again: Settings → Plugins → ${label(s)}.`);
  }
  const where = bound(conn.userId, s);
  let tokens: Tokens = await unseal<Tokens>(key(), conn.sealed, where).catch(() => {
    throw reconnect(s);
  });
  const renew = async () => {
    const app = appFor(s, tokens);
    if (!app || !tokens.refreshToken) throw reconnect(s);
    try {
      tokens = await refreshTokens(s, { app, tokens });
    } catch (err) {
      console.error(`Renewing ${s} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Turned down: connect again. Not reached, or down for now: try again later.
      const code = err instanceof OAuthError ? err.code : "";
      if (["invalid_grant", "unauthorized_client", "invalid_client", "unsupported_grant_type", "invalid_scope", "invalid_target", "invalid_request"].includes(code)) throw reconnect(s, code);
      throw new ConvexError(`${label(s)} couldn't renew its sign-in just now. Try again in a minute.`);
    }
    await ctx.runMutation(internal.connectors.updateTokens, { id: conn.id, sealed: await seal(key(), tokens, where) });
  };
  if (tokens.expiresAt && tokens.expiresAt - 60_000 < Date.now()) await renew();
  const perform = async (): Promise<unknown> => JSON.parse(JSON.stringify((await fn({ token: tokens.accessToken }, args ?? {})) ?? null));
  try {
    return await perform();
  } catch (err) {
    if (statusOf(err) === 401 && tokens.refreshToken) {
      await renew();
      try {
        return await perform();
      } catch (again) {
        throw asError(s, again);
      }
    }
    throw asError(s, err);
  }
}
