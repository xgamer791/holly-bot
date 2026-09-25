import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { requireUserId, signedInUserId } from "./lib/auth";
import { BATCH_ROWS, deleteRow, takeBatch } from "./lib/records";

/** The signed-in person as the app shows them, or null when signed out. The
 * name comes from Apple or Google and is capped like any user-supplied text. */
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("users"),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      image: v.optional(v.string()),
      providers: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await signedInUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    return {
      id: userId,
      name: user.name?.trim().slice(0, 60) || undefined,
      email: user.email,
      image: user.image,
      providers: [...new Set(accounts.map((a) => a.provider))],
    };
  },
});

/** Which sign-in buttons can work on this deployment right now. It reports
 * only whether each provider's variables are set, never their values, so the
 * sign-in screen can say what is missing instead of opening an error page. */
export const signInOptions = query({
  args: {},
  returns: v.object({ apple: v.boolean(), google: v.boolean() }),
  handler: async () => {
    const has = (...names: string[]) => names.every((name) => !!process.env[name]);
    const sessions = has("SITE_URL", "JWT_PRIVATE_KEY", "JWKS");
    return {
      apple: sessions && has("AUTH_APPLE_ID", "AUTH_APPLE_SECRET"),
      google: sessions && has("AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"),
    };
  },
});

/**
 * Deletes an account on request (the apps don't offer it). Erases every
 * record and upload the account owns, its change count and routine claims,
 * its linked computers and connected services, and its subscription
 * (cancelled at Stripe) and servers, then its sessions, sign-in methods and
 * the user itself, so the next sign-in with the same Apple or Google account
 * starts from nothing. Convex bounds the work one mutation may do, so this
 * goes in batches, called again until `done`.
 */
export const deleteAccount = mutation({
  args: {},
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    const { batch, more } = await takeBatch(
      ctx.db.query("records").withIndex("by_user_store_key", (q) => q.eq("userId", userId)),
    );
    for (const doc of batch) await deleteRow(ctx, userId, doc);
    if (more) return { done: false };

    // Uploads no record refers to any more (an upload interrupted before its record was written).
    const blobs = await ctx.db.query("blobs").withIndex("by_user", (q) => q.eq("userId", userId)).take(BATCH_ROWS + 1);
    for (const blob of blobs.slice(0, BATCH_ROWS)) {
      await ctx.db.delete(blob._id);
      if (await ctx.db.system.get(blob.storageId)) await ctx.storage.delete(blob.storageId);
    }
    if (blobs.length > BATCH_ROWS) return { done: false };

    const claims = await ctx.db.query("claims").withIndex("by_user_key", (q) => q.eq("userId", userId)).take(BATCH_ROWS + 1);
    for (const claim of claims.slice(0, BATCH_ROWS)) await ctx.db.delete(claim._id);
    if (claims.length > BATCH_ROWS) return { done: false };
    for (const head of await ctx.db.query("heads").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(head._id);
    }
    // Linked computers lose their sessions with the rest below.
    for (const device of await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(device._id);
    }
    for (const link of await ctx.db.query("deviceLinks").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(link._id);
    }
    // Connected services: the rows go now, and Google and GitHub are asked to
    // take the access back once they're gone (convex/connectors.ts).
    for (const conn of await ctx.db.query("connections").withIndex("by_user_service", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(conn._id);
      await ctx.scheduler.runAfter(0, internal.connectors.revokeLater, {
        service: conn.service,
        sealed: conn.sealed,
        bound: `${userId}:${conn.service}`,
        via: conn.via,
      });
    }
    for (const pending of await ctx.db.query("connectorClaims").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(pending._id);
    }
    for (const state of await ctx.db.query("connectorStates").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(state._id);
    }
    // The subscription ends with the account: Stripe is asked to delete its
    // customer, which cancels the subscription at once (convex/billing.ts),
    // and its servers are deleted at Vultr (convex/servers.ts).
    for (const sub of await ctx.db.query("subscribers").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(sub._id);
      if (sub.stripeCustomerId) await ctx.scheduler.runAfter(0, internal.billing.forget, { customerId: sub.stripeCustomerId, attempt: 0 });
      for (const id of [sub.serverId, sub.nextServerId]) {
        if (id) await ctx.scheduler.runAfter(0, internal.servers.destroy, { id, attempt: 0 });
      }
    }

    const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect();
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const token of tokens) await ctx.db.delete(token._id);
      await ctx.db.delete(session._id);
    }
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    for (const account of accounts) {
      const codes = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .collect();
      for (const code of codes) await ctx.db.delete(code._id);
      await ctx.db.delete(account._id);
    }
    await ctx.db.delete(userId);
    return { done: true };
  },
});
