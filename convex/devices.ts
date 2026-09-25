import { getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";

// Holly Computer, linked to an account. The signed-in app makes a random code,
// keeps it, and sends only its SHA-256 hash here (createLink). The code goes
// to the computer over the connection the two already share, and the computer
// trades it for a session of its own on the account (the `device` sign-in in
// convex/auth.ts, which calls redeem). From then on the computer keeps its
// bots in the account, the way the app does, and runs them from there.
//
// While it runs, the computer says where the account's devices can reach it
// (report), so the app on any device signed in to the account connects to it
// by itself (src/main.js), and finds it again at its new address after it
// restarts.

/** How long a link code can be used. */
const LINK_MS = 10 * 60 * 1000;

/** A computer's session. It runs unattended, so it lasts a year (a phone's
 * lasts 30 days); Holly Computer renews it well before then, and the account
 * can end it at any time (unlink). */
const DEVICE_SESSION_MS = 365 * 24 * 60 * 60 * 1000;

/** Ends the Holly Computer session of a subscriber's server that's being
 * deleted (convex/servers.ts), and drops its link code if it was never used. */
export async function forgetServerSessions(ctx: MutationCtx, serverKey: string) {
  for (const device of await ctx.db.query("devices").withIndex("by_server_key", (q) => q.eq("serverKey", serverKey)).collect()) {
    await endSession(ctx, device.sessionId);
    await ctx.db.delete(device._id);
  }
  for (const link of await ctx.db.query("deviceLinks").withIndex("by_server_key", (q) => q.eq("serverKey", serverKey)).collect()) {
    await ctx.db.delete(link._id);
  }
}

export const forgetServer = internalMutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    await forgetServerSessions(ctx, key);
    return null;
  },
});

async function endSession(ctx: MutationCtx, sessionId: Id<"authSessions">) {
  const tokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const token of tokens) await ctx.db.delete(token._id);
  if (await ctx.db.get(sessionId)) await ctx.db.delete(sessionId);
}

/** Starts linking a computer to the signed-in account. One code at a time:
 * a new one replaces any left over (but not one a subscriber's server is
 * waiting to use). Also tidies away computers whose session has ended
 * (unlinked, or renewed into a new one). A subscriber's server renewing its
 * own link (Holly Computer does after 300 days) stays marked as that server. */
export const createLink = mutation({
  args: { codeHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { codeHash }) => {
    const userId = await requireUserId(ctx);
    if (!/^[0-9a-f]{64}$/.test(codeHash)) throw new ConvexError("Bad link code");
    const sessionId = await getAuthSessionId(ctx);
    let serverKey: string | undefined;
    for (const old of await ctx.db.query("deviceLinks").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (!old.serverKey) await ctx.db.delete(old._id);
    }
    for (const device of await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (device.sessionId === sessionId) serverKey = device.serverKey;
      if (!(await ctx.db.get(device.sessionId))) await ctx.db.delete(device._id);
    }
    await ctx.db.insert("deviceLinks", { userId, codeHash, expiresAt: Date.now() + LINK_MS, ...(serverKey ? { serverKey } : null) });
    return null;
  },
});

/** Trades a link code, once and before it expires, for a new session on the
 * account it was made for. Called by the `device` sign-in (convex/auth.ts). */
export const redeem = internalMutation({
  args: { codeHash: v.string(), name: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { codeHash, name }) => {
    const link = await ctx.db
      .query("deviceLinks")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (!link) return null;
    await ctx.db.delete(link._id);
    if (link.expiresAt < Date.now() || !(await ctx.db.get(link.userId))) return null;
    const now = Date.now();
    const sessionId = await ctx.db.insert("authSessions", { userId: link.userId, expirationTime: now + DEVICE_SESSION_MS });
    await ctx.db.insert("devices", {
      userId: link.userId,
      sessionId,
      name: name.trim().slice(0, 60) || "Holly Computer",
      linkedAt: now,
      ...(link.serverKey ? { serverKey: link.serverKey } : null),
    });
    return { userId: link.userId, sessionId };
  },
});

/** The computers linked to the signed-in account, with where the account's
 * devices can reach each one while it runs. `server`: the subscriber's own
 * server, which Holly Bot links and unlinks itself (convex/servers.ts). */
export const list = query({
  args: {},
  returns: v.array(v.object({
    id: v.id("devices"),
    name: v.string(),
    linkedAt: v.number(),
    url: v.optional(v.string()),
    access: v.optional(v.string()),
    seenAt: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
    server: v.boolean(),
  })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const linked = [];
    for (const device of devices) {
      if (!(await ctx.db.get(device.sessionId))) continue;
      const { _id, name, linkedAt, url, access, seenAt, stoppedAt } = device;
      linked.push({ id: _id, name, linkedAt, url, access, seenAt, stoppedAt, server: !!device.serverKey });
    }
    return linked;
  },
});

/** A public https address, as the app will call it: no query, no fragment,
 * no trailing slash (Holly Computer's tunnel, or its --public-url). */
const ADDRESS = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%-]+)*$/;
/** The computer's access key: random, base64url. */
const ACCESS = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * A linked computer says where the account's devices can reach it
 * (computer/src/home.mjs): its address and access key, or `url: ""` when it
 * has no address they can reach (no tunnel, or the tunnel closed). It says
 * so as it starts, every few minutes while it runs, and once more with
 * `stopping` as it stops. Only a linked computer's own session can, and only
 * for itself; it needs no subscription, like the rest of devices:*. The
 * answer says whether it's the server that comes with the plan, which stays
 * linked to the account (unlink).
 */
export const report = mutation({
  args: { url: v.string(), access: v.string(), stopping: v.optional(v.boolean()) },
  returns: v.object({ server: v.boolean() }),
  handler: async (ctx, { url, access, stopping }) => {
    const userId = await requireUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const device = devices.find((row) => row.sessionId === sessionId);
    if (!device) throw new ConvexError("Only a linked Holly Computer can say where it is");
    const server = !!device.serverKey;
    if (stopping) {
      await ctx.db.patch(device._id, { url: undefined, access: undefined, stoppedAt: Date.now() });
      return { server };
    }
    if (url && (url.length > 300 || !ADDRESS.test(url))) throw new ConvexError("That address isn't a public https address");
    if (url && !ACCESS.test(access)) throw new ConvexError("Bad access key");
    await ctx.db.patch(device._id, {
      url: url || undefined,
      access: url ? access : undefined,
      seenAt: Date.now(),
      stoppedAt: undefined,
    });
    return { server };
  },
});

/** Unlinks a computer from the account: its session ends, so the next thing
 * it asks the server fails and it stops using the account. Not the server
 * that comes with the plan: that one stays linked for as long as the plan
 * lasts (convex/servers.ts links it and lets it go). */
export const unlink = mutation({
  args: { id: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db.get(id);
    if (!device || device.userId !== userId) return null;
    if (device.serverKey) throw new ConvexError("The computer that comes with your plan stays linked to your account.");
    await endSession(ctx, device.sessionId);
    await ctx.db.delete(device._id);
    return null;
  },
});
