import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// `authTables` adds `users`, `authAccounts`, `authSessions` and the other
// tables Convex Auth keeps for Apple and Google sign-in (convex/auth.ts).
export default defineSchema({
  ...authTables,

  meta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
