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

  /** One-time codes that link a Holly Computer to an account, stored as the
   * SHA-256 of the code (convex/devices.ts). */
  deviceLinks: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_code", ["codeHash"])
    .index("by_user", ["userId"]),

  /**
   * Holly Computers linked to an account, each signed in with a session of
   * its own. While one runs it says where the account's devices can reach it
   * (devices:report): `url`, its public https address, and `access`, a key
   * of its own for them (not the pairing token in its QR code) that stops
   * working when it's unlinked. `seenAt` is when it last said it was running,
   * `stoppedAt` when it said it stopped.
   */
  devices: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    name: v.string(),
    linkedAt: v.number(),
    url: v.optional(v.string()),
    access: v.optional(v.string()),
    seenAt: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  /**
   * Services connected to an account for its bots: Gmail, Outlook, GitHub
   * (convex/connectors.ts). The tokens are sealed with CONNECTORS_KEY
   * (convex/lib/seal.ts) and only opened inside actions; nothing a browser
   * can call returns them. `via` is "oauth", or "token" for a GitHub token.
   */
  connections: defineTable({
    userId: v.id("users"),
    service: v.string(),
    account: v.string(),
    scopes: v.array(v.string()),
    via: v.string(),
    sealed: v.string(),
    connectedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_service", ["userId", "service"]),

  /** A connection under way: the state sent to the service, its PKCE
   * verifier and where to come back to. Ten minutes, used once. */
  connectorStates: defineTable({
    userId: v.id("users"),
    service: v.string(),
    state: v.string(),
    verifier: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_user", ["userId"])
    .index("by_expiry", ["expiresAt"]),

  /** A connection the service approved, waiting for the app it was started
   * from to claim it (connectors:claim): it only joins the account that
   * started it, when that account's app asks. Ten minutes, used once. */
  connectorClaims: defineTable({
    userId: v.id("users"),
    service: v.string(),
    account: v.string(),
    scopes: v.array(v.string()),
    sealed: v.string(),
    claim: v.string(),
    expiresAt: v.number(),
  })
    .index("by_claim", ["claim"])
    .index("by_user", ["userId"])
    .index("by_expiry", ["expiresAt"]),

  /** Each account's customer at Stripe, made the first time it starts a
   * checkout (convex/billing.ts). One per Stripe mode: a test-mode customer
   * means nothing to live mode. */
  billingCustomers: defineTable({
    userId: v.id("users"),
    customerId: v.string(),
    livemode: v.boolean(),
  })
    .index("by_user", ["userId"])
    .index("by_customer", ["customerId"]),

  /**
   * An account's subscriptions at Stripe, as Stripe last described them (its
   * webhook, or the app asking after a checkout). Holly Bot opens for the
   * account while one of them is active (convex/lib/subscription.ts). `plan`
   * is one of convex/lib/plans.ts; times are in ms.
   */
  subscriptions: defineTable({
    userId: v.id("users"),
    customerId: v.string(),
    subscriptionId: v.string(),
    status: v.string(),
    plan: v.optional(v.string()),
    interval: v.optional(v.string()),
    priceId: v.optional(v.string()),
    periodEnd: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    livemode: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_customer", ["customerId"])
    .index("by_subscription", ["subscriptionId"]),

  meta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
