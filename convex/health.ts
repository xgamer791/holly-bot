import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const ping = query({
  args: {},
  returns: v.object({
    ok: v.literal(true),
    service: v.string(),
    now: v.number(),
  }),
  handler: async () => {
    return { ok: true as const, service: "holly-bot", now: Date.now() };
  },
});

export const upsertMeta = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  returns: v.id("meta"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("meta", {
      key: args.key,
      value: args.value,
      updatedAt,
    });
  },
});
