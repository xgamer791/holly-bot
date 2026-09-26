import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** The app's stores (src/core/db.js SCHEMA). Nothing else can be written. */
export const STORES = new Set(["kv", "agents", "threads", "messages", "memories", "files", "routines", "tasks", "activity"]);

/** Most JSON a row holds. Documents are capped at 1 MiB, so the app puts a
 * bigger record in file storage and sends its id as `overflow`. */
export const MAX_DATA = 900_000;

/** A delete batch stops after this many rows or this much data, whichever
 * comes first, to stay inside Convex's per-mutation limits. */
export const BATCH_ROWS = 256;
export const BATCH_BYTES = 6_000_000;

export function checkStore(store: string) {
  if (!STORES.has(store)) throw new ConvexError(`Unknown store: ${store}`);
}

export function checkName(value: string, what: string) {
  if (!value || value.length > 256) throw new ConvexError(`Bad ${what}`);
}

export function findRow(ctx: QueryCtx | MutationCtx, userId: Id<"users">, store: string, key: string) {
  return ctx.db
    .query("records")
    .withIndex("by_user_store_key", (q) => q.eq("userId", userId).eq("store", store).eq("key", key))
    .unique();
}

/** A row as the app reads it. An oversized record comes with a short-lived
 * URL for its JSON instead. */
export async function toClient(ctx: QueryCtx, row: Doc<"records">) {
  const overflowUrl = row.overflow ? await ctx.storage.getUrl(row.overflow) : null;
  return { key: row.key, data: row.data, ...(overflowUrl ? { overflowUrl } : null) };
}

function ownerOf(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">) {
  return ctx.db
    .query("blobs")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .unique();
}

export async function ownsBlob(ctx: QueryCtx, userId: Id<"users">, storageId: Id<"_storage">) {
  return (await ownerOf(ctx, storageId))?.userId === userId;
}

/** Records an upload as this account's the first time a record refers to it,
 * and refuses one that already belongs to another account. Its size counts
 * toward the account's files (`heads.bytes`), which `limit` caps: Free's
 * (convex/lib/plans.ts FREE.storage, which the refusal says in words). */
export async function claimBlobs(ctx: MutationCtx, userId: Id<"users">, ids: Id<"_storage">[], limit?: number) {
  const claimed: { storageId: Id<"_storage">; size: number }[] = [];
  for (const storageId of ids) {
    const owner = await ownerOf(ctx, storageId);
    if (owner) {
      if (owner.userId !== userId) throw new ConvexError("That file belongs to another account");
      continue;
    }
    const file = await ctx.db.system.get(storageId);
    if (!file) throw new ConvexError("Upload not found");
    claimed.push({ storageId, size: file.size });
  }
  if (!claimed.length) return;
  const head = await headOf(ctx, userId);
  const bytes = (head?.bytes ?? 0) + claimed.reduce((sum, c) => sum + c.size, 0);
  if (limit !== undefined && bytes > limit) {
    throw new ConvexError("Free keeps up to 100 MB of files in your account. Delete some, or upgrade for more room.");
  }
  for (const { storageId, size } of claimed) await ctx.db.insert("blobs", { userId, storageId, size });
  if (head) await ctx.db.patch(head._id, { bytes });
  else await ctx.db.insert("heads", { userId, version: 0, bytes });
}

/** Deletes the account's uploads in `old` that aren't in `keep`. Each upload
 * belongs to one record (the app never shares one between records). */
export async function releaseBlobs(ctx: MutationCtx, userId: Id<"users">, old: Id<"_storage">[], keep: Id<"_storage">[] = []) {
  let freed = 0;
  for (const storageId of old) {
    if (keep.includes(storageId)) continue;
    const owner = await ownerOf(ctx, storageId);
    if (!owner || owner.userId !== userId) continue;
    freed += owner.size ?? 0;
    await ctx.db.delete(owner._id);
    if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
  }
  const head = freed ? await headOf(ctx, userId) : null;
  if (head) await ctx.db.patch(head._id, { bytes: Math.max(0, (head.bytes ?? 0) - freed) });
}

/** Deletes one row and the uploads it holds. */
export async function deleteRow(ctx: MutationCtx, userId: Id<"users">, row: Doc<"records">) {
  await releaseBlobs(ctx, userId, row.blobs ?? []);
  await ctx.db.delete(row._id);
}

function headOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return ctx.db
    .query("heads")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** How many times the account has changed. */
export async function versionOf(ctx: QueryCtx, userId: Id<"users">) {
  return (await headOf(ctx, userId))?.version ?? 0;
}

/** How much the account's files take, in bytes (those kept since 1.43.0). */
export async function storedBytes(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return (await headOf(ctx, userId))?.bytes ?? 0;
}

/** Counts one change to the account. The app compares `prev` with the count it
 * last knew to find out whether another device wrote in between. */
export async function bump(ctx: MutationCtx, userId: Id<"users">) {
  const head = await headOf(ctx, userId);
  const prev = head?.version ?? 0;
  if (head) await ctx.db.patch(head._id, { version: prev + 1 });
  else await ctx.db.insert("heads", { userId, version: 1 });
  return { prev, version: prev + 1 };
}

/** Reads up to one delete batch from `rows`; `more` says whether rows are left. */
export async function takeBatch(rows: AsyncIterable<Doc<"records">>) {
  const batch: Doc<"records">[] = [];
  let bytes = 0;
  for await (const doc of rows) {
    if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) return { batch, more: true };
    batch.push(doc);
    bytes += doc.data.length;
  }
  return { batch, more: false };
}
