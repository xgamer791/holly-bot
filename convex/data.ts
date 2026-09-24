import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import {
  MAX_DATA,
  bump,
  checkName,
  checkStore,
  claimBlobs,
  deleteRow,
  findRow,
  ownsBlob,
  releaseBlobs,
  takeBatch,
  toClient,
  versionOf,
} from "./lib/records";

// The app's storage (src/account/cloud-db.js): every bot, chat, message,
// memory, file, routine and setting of the signed-in account. Each function
// works on the caller's own rows only (requireUserId + indexes that start with it).

/** Most changes one `apply` takes. */
const MAX_OPS = 64;
/** Most data one page of `list` reads before it stops early. */
const PAGE_BYTES = 4_000_000;

const row = v.object({ key: v.string(), data: v.string(), overflowUrl: v.optional(v.string()) });
/** The account's change count before and after a write (see `version`). */
const counted = { prev: v.number(), version: v.number() };

/** One store's rows, or one group's (a chat's messages, a bot's memories). */
export const list = query({
  args: { store: v.string(), group: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { store, group, paginationOpts }) => {
    const userId = await requireUserId(ctx);
    checkStore(store);
    const opts = { ...paginationOpts, numItems: Math.min(Math.max(paginationOpts.numItems, 1), 200), maximumBytesRead: PAGE_BYTES };
    const result = group === undefined
      ? await ctx.db
          .query("records")
          .withIndex("by_user_store_key", (q) => q.eq("userId", userId).eq("store", store))
          .paginate(opts)
      : await ctx.db
          .query("records")
          .withIndex("by_user_store_group_sort", (q) => q.eq("userId", userId).eq("store", store).eq("group", group))
          .paginate(opts);
    return {
      page: await Promise.all(result.page.map((doc) => toClient(ctx, doc))),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** The last `limit` rows of a group by `sort`, newest first (a chat's latest
 * messages, a bot's latest activity) without loading the whole group. */
export const tail = query({
  args: { store: v.string(), group: v.string(), limit: v.number() },
  returns: v.array(row),
  handler: async (ctx, { store, group, limit }) => {
    const userId = await requireUserId(ctx);
    checkStore(store);
    const docs = await ctx.db
      .query("records")
      .withIndex("by_user_store_group_sort", (q) => q.eq("userId", userId).eq("store", store).eq("group", group))
      .order("desc")
      .take(Math.min(Math.max(Math.floor(limit), 1), 100));
    return Promise.all(docs.map((doc) => toClient(ctx, doc)));
  },
});

export const get = query({
  args: { store: v.string(), key: v.string() },
  returns: v.union(row, v.null()),
  handler: async (ctx, { store, key }) => {
    const userId = await requireUserId(ctx);
    checkStore(store);
    const doc = await findRow(ctx, userId, store, key);
    return doc ? await toClient(ctx, doc) : null;
  },
});

const putOp = v.object({
  op: v.literal("put"),
  store: v.string(),
  key: v.string(),
  group: v.optional(v.string()),
  sort: v.optional(v.number()),
  data: v.string(),
  overflow: v.optional(v.id("_storage")),
  blobs: v.optional(v.array(v.id("_storage"))),
});
const deleteOp = v.object({ op: v.literal("delete"), store: v.string(), key: v.string() });

/** Writes and deletes, in order. A record's uploads are claimed for the
 * account when it's written, and deleted when it's deleted or no longer
 * refers to them. */
export const apply = mutation({
  args: { ops: v.array(v.union(putOp, deleteOp)) },
  returns: v.object(counted),
  handler: async (ctx, { ops }) => {
    const userId = await requireUserId(ctx);
    if (!ops.length || ops.length > MAX_OPS) throw new ConvexError("Send between 1 and 64 changes at once");
    for (const op of ops) {
      checkStore(op.store);
      checkName(op.key, "key");
      const existing = await findRow(ctx, userId, op.store, op.key);
      if (op.op === "delete") {
        if (existing) await deleteRow(ctx, userId, existing);
        continue;
      }
      if (op.group !== undefined) checkName(op.group, "group");
      if (op.data.length > MAX_DATA) throw new ConvexError("Record too large");
      const blobs = [...new Set([...(op.blobs ?? []), ...(op.overflow ? [op.overflow] : [])])];
      if (blobs.length > 16) throw new ConvexError("Too many files in one record");
      await claimBlobs(ctx, userId, blobs);
      const doc = {
        userId,
        store: op.store,
        key: op.key,
        group: op.group,
        sort: op.sort,
        data: op.data,
        overflow: op.overflow,
        blobs,
        updatedAt: Date.now(),
      };
      if (existing) {
        await releaseBlobs(ctx, userId, existing.blobs ?? [], blobs);
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("records", doc);
      }
    }
    return await bump(ctx, userId);
  },
});

/** Deletes a batch of one store's rows; the app repeats until `done`. */
export const clearStore = mutation({
  args: { store: v.string() },
  returns: v.object({ done: v.boolean(), ...counted }),
  handler: async (ctx, { store }) => {
    const userId = await requireUserId(ctx);
    checkStore(store);
    const { batch, more } = await takeBatch(
      ctx.db.query("records").withIndex("by_user_store_key", (q) => q.eq("userId", userId).eq("store", store)),
    );
    for (const doc of batch) await deleteRow(ctx, userId, doc);
    return { done: !more, ...(await bump(ctx, userId)) };
  },
});

/** How many times the account has changed. A device checks it now and then:
 * a count that moved without its own writes means another device changed the
 * account, and what this device holds in memory is out of date. */
export const version = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => versionOf(ctx, await requireUserId(ctx)),
});

/** Takes on a piece of scheduled work (`key`, due at `at`) for this device.
 * True for the first device to ask about that run; false for any other, and
 * for a run at or before one already taken. */
export const claim = mutation({
  args: { key: v.string(), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { key, at }) => {
    const userId = await requireUserId(ctx);
    checkName(key, "key");
    const taken = await ctx.db
      .query("claims")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .unique();
    if (taken && taken.at >= at) return false;
    if (taken) await ctx.db.patch(taken._id, { at });
    else await ctx.db.insert("claims", { userId, key, at });
    return true;
  },
});

/** Where to upload a file's contents before writing the record that holds it. */
export const uploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireUserId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** A short-lived download URL for one of the account's own uploads. */
export const blobUrl = query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { storageId }) => {
    const userId = await requireUserId(ctx);
    if (!(await ownsBlob(ctx, userId, storageId))) return null;
    return await ctx.storage.getUrl(storageId);
  },
});
