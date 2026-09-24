import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 200;
const MARK = "uploads.sweptTo";

/**
 * Deletes uploads that no record claimed within a day: a file sent just before
 * the app closed or the change was refused, or an upload URL used for nothing.
 * Walks file storage in creation order from where the last sweep stopped, so
 * each upload is looked at once. Runs daily (convex/crons.ts) and continues
 * itself until it catches up.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const mark = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", MARK))
      .unique();
    const from = mark ? Number(mark.value) : 0;
    const files = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", from).lt("_creationTime", Date.now() - DAY))
      .take(BATCH);
    for (const file of files) {
      const owner = await ctx.db
        .query("blobs")
        .withIndex("by_storage", (q) => q.eq("storageId", file._id))
        .unique();
      if (!owner) await ctx.storage.delete(file._id);
    }
    if (!files.length) return null;
    const value = String(files[files.length - 1]._creationTime);
    if (mark) await ctx.db.patch(mark._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("meta", { key: MARK, value, updatedAt: Date.now() });
    if (files.length === BATCH) await ctx.scheduler.runAfter(0, internal.uploads.sweep, {});
    return null;
  },
});
