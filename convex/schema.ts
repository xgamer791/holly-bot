import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Scaffold only — expand when Holly Bot app wiring starts.
export default defineSchema({
  meta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
