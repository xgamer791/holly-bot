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

/** How long a link code can be used. */
const LINK_MS = 10 * 60 * 1000;

/** A computer's session. It runs unattended, so it lasts a year (a phone's
 * lasts 30 days); Holly Computer renews it well before then, and the account
 * can end it at any time (unlink). */
const DEVICE_SESSION_MS = 365 * 24 * 60 * 60 * 1000;

async function endSession(ctx: MutationCtx, sessionId: Id<"authSessions">) {
  const tokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const token of tokens) await ctx.db.delete(token._id);
  if (await ctx.db.get(sessionId)) await ctx.db.delete(sessionId);
}

/** Starts linking a computer to the signed-in account. One code at a time:
 * a new one replaces any left over. Also tidies away computers whose session
 * has ended (unlinked, or renewed into a new one). */
export const createLink = mutation({
  args: { codeHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { codeHash }) => {
    const userId = await requireUserId(ctx);
    if (!/^[0-9a-f]{64}$/.test(codeHash)) throw new ConvexError("Bad link code");
    for (const old of await ctx.db.query("deviceLinks").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(old._id);
    }
    for (const device of await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (!(await ctx.db.get(device.sessionId))) await ctx.db.delete(device._id);
    }
    await ctx.db.insert("deviceLinks", { userId, codeHash, expiresAt: Date.now() + LINK_MS });
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
    });
    return { userId: link.userId, sessionId };
  },
});

/** The computers linked to the signed-in account. */
export const list = query({
  args: {},
  returns: v.array(v.object({ id: v.id("devices"), name: v.string(), linkedAt: v.number() })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const linked = [];
    for (const device of devices) {
      if (await ctx.db.get(device.sessionId)) linked.push({ id: device._id, name: device.name, linkedAt: device.linkedAt });
    }
    return linked;
  },
});

/** Unlinks a computer from the account: its session ends, so the next thing
 * it asks the server fails and it stops using the account. */
export const unlink = mutation({
  args: { id: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db.get(id);
    if (!device || device.userId !== userId) return null;
    await endSession(ctx, device.sessionId);
    await ctx.db.delete(device._id);
    return null;
  },
});
