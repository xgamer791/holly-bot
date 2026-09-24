import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// `authTables` adds `users`, `authAccounts`, `authSessions` and the other
// tables Convex Auth keeps for Apple and Google sign-in (convex/auth.ts).
export default defineSchema({
  ...authTables,

  /**
   * Everything the app keeps for an account: one row per record of one of the
   * app's stores (bots, chats, messages, memories, files, routines, tasks,
   * activity, settings; see STORES in convex/lib/records.ts). Every row
   * carries its owner, and every function reads and writes through an index
   * that starts with the signed-in user, so no account can reach another's.
   *
   * `data` is the record as JSON: the app's records hold arbitrary JSON (tool
   * schemas with `$` keys, deep nesting) that Convex values can't. A record
   * too big for a document lives in file storage (`overflow`). `group` and
   * `sort` let the app load one chat's messages, or one bot's memories, at a
   * time, newest first when it wants.
   */
  records: defineTable({
    userId: v.id("users"),
    store: v.string(),
    key: v.string(),
    group: v.optional(v.string()),
    sort: v.optional(v.number()),
    data: v.string(),
    overflow: v.optional(v.id("_storage")),
    blobs: v.optional(v.array(v.id("_storage"))),
    updatedAt: v.number(),
  })
    .index("by_user_store_key", ["userId", "store", "key"])
    .index("by_user_store_group_sort", ["userId", "store", "group", "sort"]),

  /** Who owns each uploaded file (a file's contents, or an oversized record). */
  blobs: defineTable({
    userId: v.id("users"),
    storageId: v.id("_storage"),
  })
    .index("by_storage", ["storageId"])
    .index("by_user", ["userId"]),

  /** How many times each account has changed. A device that sees the count
   * move without its own writes knows another device changed the account. */
  heads: defineTable({
    userId: v.id("users"),
    version: v.number(),
  }).index("by_user", ["userId"]),

  /** Scheduled work a device has taken on (a routine's run due at `at`), so
   * two devices open on one account never both do it. */
  claims: defineTable({
    userId: v.id("users"),
    key: v.string(),
    at: v.number(),
  }).index("by_user_key", ["userId", "key"]),

  meta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
