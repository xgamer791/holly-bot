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

  /** One-time codes that link a Holly Bot Computer to an account, stored as the
   * SHA-256 of the code (convex/devices.ts). */
  deviceLinks: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    expiresAt: v.number(),
    /** For a subscriber's server (convex/servers.ts): which one. */
    serverKey: v.optional(v.string()),
    /** A computer renewing its own link keeps having been connected to (devices.pairedAt). */
    pairedAt: v.optional(v.number()),
  })
    .index("by_code", ["codeHash"])
    .index("by_user", ["userId"])
    .index("by_server_key", ["serverKey"]),

  /**
   * Holly Bot Computers linked to an account, each signed in with a session of
   * its own. While one runs it says where the account's devices can reach it
   * (devices:report): `url`, its public https address, and `access`, a key
   * of its own for them (not the pairing token in its QR code) that stops
   * working when it's unlinked. `seenAt` is when it last said it was running,
   * `stoppedAt` when it said it stopped. `tunnel` says why a running one has
   * no address: 'off' (none wanted), 'starting' (opening its tunnel) or
   * 'blocked' (its network blocks the tunnel). `pairedAt`: when Holly Bot on a
   * phone first connected to it (Connect), after which the account's devices
   * connect to it by themselves (devices:pair). `platform`: its system
   * ('win32', 'darwin' or 'linux'), so the bots can say "your Windows PC".
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
    tunnel: v.optional(v.string()),
    pairedAt: v.optional(v.number()),
    platform: v.optional(v.string()),
    /** A subscriber's server (convex/servers.ts): its session ends when the server is deleted. */
    serverKey: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_server_key", ["serverKey"]),

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
    /** The client registered for this connection, for a service Holly Bot
     * registers with as each connection starts (Higgsfield). */
    clientId: v.optional(v.string()),
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

  /**
   * Each subscriber: their Stripe customer and subscription as Stripe last
   * described them (convex/billing.ts), and the dedicated Vultr server that
   * runs Holly for them (convex/servers.ts). One row per account, made when it
   * first starts a checkout. Times are in ms.
   *
   * serverStatus is none, provisioning, ready, resizing (an upgrade, or a move
   * to a smaller server), deleting or error. serverReadyToken holds the
   * SHA-256 of the one-time token a server reports ready with. serverKey ties a
   * server to the Holly Bot Computer session it links with (devices.serverKey). A
   * downgrade builds the smaller server as nextServer*, then swaps it in.
   */
  subscribers: defineTable({
    userId: v.id("users"),
    /** Whether the Stripe customer and subscription are live or test mode. */
    livemode: v.boolean(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    plan: v.optional(v.string()),
    billingInterval: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    /** When the subscription ended, or is set to end. */
    cancelAt: v.optional(v.number()),
    serverStatus: v.string(),
    serverId: v.optional(v.string()),
    serverIp: v.optional(v.string()),
    serverPlan: v.optional(v.string()),
    serverReadyToken: v.optional(v.string()),
    serverCreatedAt: v.optional(v.number()),
    serverError: v.optional(v.string()),
    serverKey: v.optional(v.string()),
    /** Where the app reaches the server, and its Holly Bot Computer pairing token. */
    serverUrl: v.optional(v.string()),
    serverPairingToken: v.optional(v.string()),
    /** When the work under way (provisioning, resizing) started. */
    serverWorkStartedAt: v.optional(v.number()),
    nextServerId: v.optional(v.string()),
    nextServerIp: v.optional(v.string()),
    nextServerPlan: v.optional(v.string()),
    nextServerKey: v.optional(v.string()),
    /** When the app last asked to set the server up again (servers:retry). */
    retriedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_customer", ["stripeCustomerId"])
    .index("by_server", ["serverId"])
    .index("by_next_server", ["nextServerId"]),

  /** Stripe events already handled, so a delivery Stripe repeats is skipped
   * (convex/billing.ts). Kept 30 days. */
  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    processedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_time", ["processedAt"]),

  /**
   * Each account's AI credits (convex/credits.ts): what's left of this
   * month's allowance from its plan, in millionths of a US dollar of DeepSeek
   * use at DeepSeek's list prices. Months count from `anchor`, and a new one
   * refills `balance` to `allowance`. The rest are this month's totals. See
   * Ledger in convex/lib/credits.ts.
   */
  credits: defineTable({
    userId: v.id("users"),
    anchor: v.number(),
    periodStart: v.number(),
    periodEnd: v.number(),
    allowance: v.number(),
    balance: v.number(),
    spent: v.number(),
    requests: v.number(),
    cachedTokens: v.number(),
    freshTokens: v.number(),
    outputTokens: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  meta: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
