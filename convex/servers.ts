import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { LIVE_SITE } from "./auth";
import { forgetServerSessions } from "./devices";
import { requireUserId } from "./lib/auth";
import { setupScript } from "./lib/cloudinit";
import { SERVERS, planById, planOfServer, rank } from "./lib/plans";
import { hasAccess, isPaid, subscriberOf } from "./lib/subscription";
import { connect, vultrSettings, type Instance, type Vultr } from "./lib/vultr";

// Every subscriber's own dedicated server at Vultr, running Holly Computer
// linked to their account, so their bots run there around the clock. It's
// made when they subscribe, resized when they upgrade, moved to a smaller one
// when they downgrade, and deleted when the subscription ends, all from here:
//
//   none → provisioning → ready            a new server (provision)
//   ready → resizing → ready               an upgrade: Vultr resizes it (resize)
//   ready → resizing → ready               a downgrade: a smaller server is made,
//                                          takes the bots' files, and replaces it (migrate)
//   … → deleting → none                    the subscription ended (remove)
//   provisioning → error                   setup failed, or took over 15 minutes
//
// Only Stripe's webhook (convex/billing.ts), the scheduler and the nightly
// reconcile make or delete servers: everything that calls Vultr is internal.
// The app can only ask for a failed setup to start again (`retry`), which
// schedules it. A server reports in over POST /servers/ready with the
// one-time token it was made with (convex/lib/cloudinit.ts).
//
// Variables (CONVEX.md): VULTR_API_KEY, and VULTR_DRY_RUN=true to log the
// calls to Vultr instead of making them (made-up servers "finish setting up"
// after a few seconds, so the app's flow can be tried end to end).

/** A new server has this long to report ready. */
const SETUP_MS = 15 * 60_000;
/** An upgrade has this long to finish at Vultr. */
const RESIZE_MS = 30 * 60_000;
/** How often Vultr is asked about a server being made or resized. */
const WATCH_MS = 10_000;
/** How long a server's link code works. */
const LINK_MS = 2 * 60 * 60_000;
/** servers:retry, at most this often. */
const RETRY_GAP_MS = 60_000;
/** A dry run's made-up server reports ready after this. */
const DRY_READY_MS = 15_000;

const client = (): Vultr | null => connect(vultrSettings(process.env as Record<string, string | undefined>));
const labelOf = (userId: string) => `${SERVERS.labelPrefix}${userId}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function secret(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const byte of raw) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Everything about a server, cleared (a patch that removes the fields). */
const NO_SERVER = {
  serverId: undefined,
  serverIp: undefined,
  serverPlan: undefined,
  serverReadyToken: undefined,
  serverCreatedAt: undefined,
  serverError: undefined,
  serverKey: undefined,
  serverUrl: undefined,
  serverPairingToken: undefined,
  serverWorkStartedAt: undefined,
};
const NO_NEXT = { nextServerId: undefined, nextServerIp: undefined, nextServerPlan: undefined, nextServerKey: undefined };

/** What the app shows about the server (billing:status). `step` says how far
 * a new server has got: creating, starting (made, waiting for its address)
 * or installing (setting up Holly). */
export function serverView(row: Doc<"subscribers">) {
  const step = row.serverStatus !== "provisioning" ? undefined : !row.serverId ? "creating" : !row.serverIp ? "starting" : "installing";
  return {
    status: row.serverStatus,
    step,
    since: row.serverWorkStartedAt,
    error: row.serverError,
    ip: row.serverIp,
    plan: planOfServer(row.serverPlan)?.id,
  };
}

/**
 * Schedules what a subscriber's server should do after their subscription
 * changed: made (paid, and none yet), resized (a bigger plan), moved to a
 * smaller one (a smaller plan) or, when `ended`, deleted. Called by Stripe's
 * webhook (convex/billing.ts) and when a server finishes some work.
 */
export async function planServer(ctx: MutationCtx, row: Doc<"subscribers">, { ended = false } = {}) {
  const now = Date.now();
  if (ended || !hasAccess(row, now)) {
    if (ended && (row.serverId || row.nextServerId || row.serverStatus !== "none")) {
      await ctx.scheduler.runAfter(0, internal.servers.remove, { userId: row.userId });
    }
    return;
  }
  if (!row.serverId && row.serverStatus === "none" && isPaid(row, now)) {
    await ctx.scheduler.runAfter(0, internal.servers.provision, { userId: row.userId });
    return;
  }
  if (row.serverId && row.serverStatus === "ready" && !row.nextServerId) {
    const want = rank(row.plan);
    const have = rank(planOfServer(row.serverPlan)?.id);
    if (want < 0 || have < 0 || want === have) return;
    await ctx.scheduler.runAfter(0, want > have ? internal.servers.resize : internal.servers.migrate, { userId: row.userId });
  }
}

// ----- a new server ---------------------------------------------------------

/**
 * Makes a subscriber's server. Does nothing if they already have one or one
 * is being made, and refuses when the Vultr account has SERVERS.max of them.
 * The server's id is kept the moment Vultr answers; then Vultr is asked for
 * its address (`watch`) until it has one, and the server reports in over
 * /servers/ready once Holly is running (or `timeout` marks it failed).
 */
export const provision = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const readyToken = secret();
    const linkCode = secret();
    const key = secret(12);
    const job = await ctx.runMutation(internal.servers.claimNew, {
      userId,
      key,
      readyHash: await sha256(readyToken),
      linkHash: await sha256(linkCode),
    });
    if (job) await build(ctx, { userId, key, plan: job.plan, readyToken, linkCode, slot: "server" });
    return null;
  },
});

export const claimNew = internalMutation({
  args: { userId: v.id("users"), key: v.string(), readyHash: v.string(), linkHash: v.string() },
  returns: v.union(v.null(), v.object({ plan: v.string() })),
  handler: async (ctx, a) => {
    const row = await subscriberOf(ctx, a.userId);
    const now = Date.now();
    // Never a second server: nothing while one exists or is being made.
    if (!row || row.serverId || !["none", "error"].includes(row.serverStatus) || !isPaid(row, now)) return null;
    const plan = planById(row.plan);
    if (!plan) {
      console.error(`Servers: ${a.userId} pays for a plan Holly Bot doesn't know (${row.plan}); no server made.`);
      return null;
    }
    await ctx.db.insert("deviceLinks", { userId: a.userId, codeHash: a.linkHash, expiresAt: now + LINK_MS, serverKey: a.key });
    await ctx.db.patch(row._id, {
      ...NO_SERVER,
      serverStatus: "provisioning",
      serverKey: a.key,
      serverReadyToken: a.readyHash,
      serverWorkStartedAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(SETUP_MS, internal.servers.timeout, { userId: a.userId, key: a.key });
    return { plan: plan.server };
  },
});

/** Makes a server at Vultr for `slot` (the subscriber's server, or the
 * smaller one a downgrade moves to) and keeps its id. */
async function build(
  ctx: ActionCtx,
  o: {
    userId: Id<"users">;
    key: string;
    plan: string;
    readyToken: string;
    linkCode: string;
    slot: "server" | "next";
    from?: { url: string; token: string };
    exclude?: string;
  },
) {
  const fail = (reason: string) => ctx.runMutation(internal.servers.failed, { userId: o.userId, key: o.key, reason });
  const vultr = client();
  if (!vultr) {
    console.error("Servers: VULTR_API_KEY isn't set, so no server can be made.");
    await fail("Servers aren't set up on Holly Bot's server yet.");
    return;
  }
  const label = labelOf(o.userId);
  let instance: Instance;
  try {
    if (!vultr.dryRun) {
      let all = await vultr.list({ tag: SERVERS.tag });
      // One made for this account that it doesn't know about is left from a
      // setup that stopped partway (its one-time tokens are spent): it goes
      // first, so the account never has two.
      if (o.slot === "server") {
        for (const leftover of all.filter((i) => i.label === label && i.id !== o.exclude)) {
          await vultr.remove(leftover.id);
          console.log(`Servers: deleted ${leftover.id}, left from an earlier setup for ${o.userId}.`);
          all = all.filter((i) => i.id !== leftover.id);
        }
      }
      if (all.length >= SERVERS.max) {
        console.warn(`Servers: the Vultr account has ${all.length} ${SERVERS.tag} servers, the most Holly Bot makes (Vultr allows 30 servers and $1,000 a month). Not making one for ${o.userId}. Ask Vultr to raise the account's limits.`);
        await fail("Holly Bot can't set up another computer right now. It will as soon as there's room; you can also try again later.");
        return;
      }
    }
    const deployment = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
    if (!deployment) throw new Error("CONVEX_SITE_URL isn't set");
    instance = await vultr.create({
      region: SERVERS.region,
      plan: o.plan,
      osId: await vultr.osId(SERVERS.os),
      label,
      tag: SERVERS.tag,
      hostname: "holly",
      exclude: o.exclude ? [o.exclude] : [],
      userData: setupScript({
        userId: o.userId,
        readyUrl: `${deployment}/servers/ready`,
        readyToken: o.readyToken,
        linkCode: o.linkCode,
        site: LIVE_SITE,
        name: SERVERS.name,
        from: o.from,
      }),
    });
  } catch (err) {
    console.error(`Servers: making ${label} at Vultr failed: ${message(err)}`);
    await fail(`Couldn't create your computer at Vultr: ${message(err)}`);
    return;
  }
  const kept = await ctx.runMutation(internal.servers.made, { userId: o.userId, key: o.key, slot: o.slot, id: instance.id, ip: instance.ip, plan: o.plan });
  if (!kept) {
    // Not wanted any more (the subscription ended, or setup started over meanwhile).
    await ctx.scheduler.runAfter(0, internal.servers.destroy, { id: instance.id, key: o.key, attempt: 0 });
    return;
  }
  await ctx.scheduler.runAfter(vultr.dryRun ? 1_000 : WATCH_MS, internal.servers.watch, { userId: o.userId, key: o.key, id: instance.id });
}

/** Keeps the id of a server Vultr just made; false if it isn't wanted any more. */
export const made = internalMutation({
  args: { userId: v.id("users"), key: v.string(), slot: v.union(v.literal("server"), v.literal("next")), id: v.string(), ip: v.string(), plan: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const row = await subscriberOf(ctx, a.userId);
    if (!row) return false;
    const now = Date.now();
    if (a.slot === "server") {
      if (row.serverKey !== a.key || row.serverId) return false;
      await ctx.db.patch(row._id, { serverId: a.id, serverIp: a.ip || undefined, serverPlan: a.plan, serverCreatedAt: now, updatedAt: now });
    } else {
      if (row.nextServerKey !== a.key || row.nextServerId) return false;
      await ctx.db.patch(row._id, { nextServerId: a.id, nextServerIp: a.ip || undefined, nextServerPlan: a.plan, updatedAt: now });
    }
    // The subscription ended while it was being made.
    if (!hasAccess(row, now)) await ctx.scheduler.runAfter(0, internal.servers.remove, { userId: a.userId });
    return true;
  },
});

/** Asks Vultr about a server being made until it has an address. */
export const watch = internalAction({
  args: { userId: v.id("users"), key: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const vultr = client();
    if (!vultr) return null;
    let instance: Instance | null | undefined;
    try {
      instance = await vultr.get(a.id);
    } catch (err) {
      console.warn(`Servers: asking Vultr about ${a.id}: ${message(err)}`);
    }
    if (instance === null) {
      await ctx.runMutation(internal.servers.failed, { userId: a.userId, key: a.key, reason: "Your computer disappeared at Vultr while it was being set up." });
      return null;
    }
    const next = await ctx.runMutation(internal.servers.addressed, { userId: a.userId, key: a.key, ip: instance?.ip ?? "" });
    if (next === "wait") await ctx.scheduler.runAfter(WATCH_MS, internal.servers.watch, a);
    // A dry run's server has nothing to install: it "reports ready" shortly.
    if (next === "addressed" && vultr.dryRun) await ctx.scheduler.runAfter(DRY_READY_MS, internal.servers.pretendReady, { userId: a.userId, key: a.key });
    return null;
  },
});

/** Keeps a server's address. "wait": ask again; "addressed": kept; "stop":
 * the setup is over (finished, failed, replaced or out of time). */
export const addressed = internalMutation({
  args: { userId: v.id("users"), key: v.string(), ip: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const row = await subscriberOf(ctx, a.userId);
    const now = Date.now();
    const current = row?.serverKey === a.key && ["provisioning", "ready", "error"].includes(row.serverStatus);
    const next = row?.nextServerKey === a.key;
    if (!row || (!current && !next)) return "stop";
    if (a.ip) {
      await ctx.db.patch(row._id, current ? { serverIp: a.ip, updatedAt: now } : { nextServerIp: a.ip, updatedAt: now });
      return "addressed";
    }
    return now - (row.serverWorkStartedAt ?? now) < SETUP_MS ? "wait" : "stop";
  },
});

/** Fifteen minutes after a server was started: if it hasn't reported ready,
 * it's failed, with what was last known about it. A downgrade that didn't
 * finish leaves the old server running. */
export const timeout = internalMutation({
  args: { userId: v.id("users"), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, key }) => {
    const row = await subscriberOf(ctx, userId);
    if (row?.serverKey === key && row.serverStatus === "provisioning") {
      const reason = !row.serverId
        ? "Your computer wasn't created at Vultr within 15 minutes."
        : !row.serverIp
          ? "Vultr didn't give your computer an address within 15 minutes."
          : "Holly didn't finish setting up on your computer within 15 minutes.";
      console.warn(`Servers: ${userId}: ${reason}`);
      await ctx.db.patch(row._id, { serverStatus: "error", serverError: reason, updatedAt: Date.now() });
    } else if (row?.nextServerKey === key) {
      await giveUpMove(ctx, row, "it didn't finish in time");
    }
    return null;
  },
});

/** A setup that went wrong (Vultr refused, the server reported an error). */
export const failed = internalMutation({
  args: { userId: v.id("users"), key: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, key, reason }) => {
    const row = await subscriberOf(ctx, userId);
    if (row?.serverKey === key && row.serverStatus === "provisioning") {
      await ctx.db.patch(row._id, { serverStatus: "error", serverError: reason.slice(0, 400), updatedAt: Date.now() });
    } else if (row?.nextServerKey === key) {
      await giveUpMove(ctx, row, reason);
    }
    return null;
  },
});

/** Drops a smaller server that didn't work out; the subscriber keeps the one
 * they have, and the nightly reconcile tries the move again. */
async function giveUpMove(ctx: MutationCtx, row: Doc<"subscribers">, reason: string) {
  console.warn(`Servers: ${row.userId}: moving to a smaller server didn't work: ${reason}`);
  if (row.nextServerId) await ctx.scheduler.runAfter(0, internal.servers.destroy, { id: row.nextServerId, key: row.nextServerKey, attempt: 0 });
  await ctx.db.patch(row._id, {
    ...NO_NEXT,
    serverStatus: row.serverStatus === "resizing" ? "ready" : row.serverStatus,
    serverReadyToken: undefined,
    serverWorkStartedAt: undefined,
    serverError: "Moving to your new plan's smaller computer didn't work. Holly Bot will try again tonight.",
    updatedAt: Date.now(),
  });
}

/**
 * Where a server reports in (convex/http.ts routes POST /servers/ready here),
 * once Holly is running on it: { userId, token, url, pairingToken }, or
 * { userId, token, error } when its setup failed. The token is the one-time
 * token it was made with.
 */
export const ready = httpAction(async (ctx, request) => {
  const reply = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return reply(400, "Send JSON");
  }
  const text = (value: unknown, max: number) => (typeof value === "string" && value.length <= max ? value : undefined);
  const userId = text(body?.userId, 64);
  const token = text(body?.token, 200);
  if (!userId || !token) return reply(400, "Send userId and token");
  const result = await ctx.runMutation(internal.servers.reported, {
    userId,
    tokenHash: await sha256(token),
    url: text(body?.url, 200),
    pairingToken: text(body?.pairingToken, 200),
    error: typeof body?.error === "string" ? body.error.slice(0, 400) : undefined,
  });
  return result === "ok" ? reply(200, "ok") : reply(403, "That token isn't valid");
});

export const reported = internalMutation({
  args: { userId: v.string(), tokenHash: v.string(), url: v.optional(v.string()), pairingToken: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    const userId = ctx.db.normalizeId("users", a.userId);
    const row = userId ? await subscriberOf(ctx, userId) : null;
    if (!row?.serverReadyToken || row.serverReadyToken !== a.tokenHash) return "refused";
    const moving = !!row.nextServerKey;
    // Until its id is kept (a moment after Vultr made it), a server's report
    // is refused; it tries again for a few minutes.
    if (moving ? !row.nextServerId : !(row.serverId && ["provisioning", "error"].includes(row.serverStatus))) return "refused";
    const url = a.url && /^https:\/\/[^\s/]+$/.test(a.url) ? a.url : undefined;
    if (a.error || !url || !a.pairingToken) {
      const reason = a.error || "It reported ready without its address.";
      console.warn(`Servers: ${row.userId}: setup failed on the server: ${reason}`);
      if (moving) await giveUpMove(ctx, row, reason);
      else await ctx.db.patch(row._id, { serverStatus: "error", serverError: `Setting up your computer failed: ${reason}`, serverReadyToken: undefined, updatedAt: Date.now() });
      return "ok";
    }
    await becameReady(ctx, row, { url, pairingToken: a.pairingToken });
    return "ok";
  },
});

/** A dry run's made-up server, "reporting ready". */
export const pretendReady = internalMutation({
  args: { userId: v.id("users"), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, key }) => {
    const row = await subscriberOf(ctx, userId);
    if (!row || !client()?.dryRun) return null;
    if ((row.serverKey === key && row.serverStatus === "provisioning" && row.serverId) || (row.nextServerKey === key && row.nextServerId)) await becameReady(ctx, row, {});
    return null;
  },
});

/** A server finished setting up: it's the subscriber's server now. A smaller
 * one that took over from a bigger one (a downgrade) replaces it, and the
 * old one is deleted. A plan change made meanwhile is then carried out. */
async function becameReady(ctx: MutationCtx, row: Doc<"subscribers">, o: { url?: string; pairingToken?: string }) {
  const now = Date.now();
  const done = { serverStatus: "ready", serverUrl: o.url, serverPairingToken: o.pairingToken, serverReadyToken: undefined, serverError: undefined, serverWorkStartedAt: undefined, updatedAt: now };
  if (row.nextServerKey) {
    if (row.serverId) await ctx.scheduler.runAfter(0, internal.servers.destroy, { id: row.serverId, key: row.serverKey, attempt: 0 });
    await ctx.db.patch(row._id, {
      ...done,
      ...NO_NEXT,
      serverId: row.nextServerId,
      serverIp: row.nextServerIp ?? ipOf(o.url),
      serverPlan: row.nextServerPlan,
      serverKey: row.nextServerKey,
      serverCreatedAt: now,
    });
    console.log(`Servers: ${row.userId} moved from ${row.serverId} to ${row.nextServerId} (${row.nextServerPlan}).`);
  } else {
    await ctx.db.patch(row._id, { ...done, serverIp: row.serverIp ?? ipOf(o.url) });
    console.log(`Servers: ${row.userId}'s server ${row.serverId} is ready.`);
  }
  const updated = await ctx.db.get(row._id);
  if (updated) await planServer(ctx, updated);
}

/** 45-76-1-2.sslip.io → 45.76.1.2 */
function ipOf(url: string | undefined): string | undefined {
  const m = url?.match(/^https:\/\/(\d+)-(\d+)-(\d+)-(\d+)\./);
  return m ? m.slice(1, 5).join(".") : undefined;
}

// ----- an upgrade: Vultr resizes the server ----------------------------------

export const resize = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const job = await ctx.runMutation(internal.servers.claimResize, { userId });
    if (!job) return null;
    const vultr = client();
    try {
      if (!vultr) throw new Error("VULTR_API_KEY isn't set");
      await vultr.resize(job.id, job.plan);
      await ctx.scheduler.runAfter(vultr.dryRun ? 5_000 : WATCH_MS, internal.servers.watchResize, { userId, id: job.id, plan: job.plan, startedAt: Date.now() });
    } catch (err) {
      console.error(`Servers: resizing ${job.id} to ${job.plan} failed: ${message(err)}`);
      await ctx.runMutation(internal.servers.resized, { userId, id: job.id, plan: job.plan, done: false, reason: "Upgrading your computer didn't work. Holly Bot will try again tonight." });
    }
    return null;
  },
});

export const claimResize = internalMutation({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), v.object({ id: v.string(), plan: v.string() })),
  handler: async (ctx, { userId }) => {
    const row = await subscriberOf(ctx, userId);
    const plan = planById(row?.plan);
    if (!row?.serverId || row.serverStatus !== "ready" || row.nextServerId || !plan || !hasAccess(row)) return null;
    if (rank(plan.id) <= rank(planOfServer(row.serverPlan)?.id)) return null;
    await ctx.db.patch(row._id, { serverStatus: "resizing", serverError: undefined, serverWorkStartedAt: Date.now(), updatedAt: Date.now() });
    return { id: row.serverId, plan: plan.server };
  },
});

/** Asks Vultr about a server being resized until it's running on the new plan. */
export const watchResize = internalAction({
  args: { userId: v.id("users"), id: v.string(), plan: v.string(), startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const vultr = client();
    let instance: Instance | null | undefined;
    try {
      instance = vultr?.dryRun ? undefined : await vultr?.get(a.id);
    } catch (err) {
      console.warn(`Servers: asking Vultr about ${a.id}: ${message(err)}`);
    }
    const running = (i: Instance) => i.plan === a.plan && i.status === "active" && i.power === "running";
    if (vultr?.dryRun || (instance && running(instance))) {
      await ctx.runMutation(internal.servers.resized, { userId: a.userId, id: a.id, plan: a.plan, done: true });
    } else if (instance === null) {
      await ctx.runMutation(internal.servers.resized, { userId: a.userId, id: a.id, plan: a.plan, done: false, reason: "Your computer disappeared at Vultr while it was being upgraded." });
    } else if (Date.now() - a.startedAt > RESIZE_MS) {
      const moved = instance?.plan === a.plan;
      await ctx.runMutation(internal.servers.resized, {
        userId: a.userId,
        id: a.id,
        plan: a.plan,
        done: moved,
        reason: moved ? undefined : "Upgrading your computer is taking longer than it should. Holly Bot will check on it tonight.",
      });
    } else {
      await ctx.scheduler.runAfter(WATCH_MS, internal.servers.watchResize, a);
    }
    return null;
  },
});

export const resized = internalMutation({
  args: { userId: v.id("users"), id: v.string(), plan: v.string(), done: v.boolean(), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await subscriberOf(ctx, a.userId);
    if (!row || row.serverId !== a.id || row.serverStatus !== "resizing") return null;
    await ctx.db.patch(row._id, {
      serverStatus: "ready",
      serverWorkStartedAt: undefined,
      serverError: a.done ? undefined : a.reason,
      ...(a.done ? { serverPlan: a.plan } : null),
      updatedAt: Date.now(),
    });
    if (a.done) {
      console.log(`Servers: ${a.userId}'s server ${a.id} is now ${a.plan}.`);
      const updated = await ctx.db.get(row._id);
      if (updated) await planServer(ctx, updated);
    }
    return null;
  },
});

// ----- a downgrade: a smaller server takes over ------------------------------

/**
 * Vultr can't make a server smaller, so a downgrade makes a new server at the
 * smaller size, which copies the bots' files from the old one while it sets
 * up (their bots, chats and memories are in the account already). Once it
 * reports ready it takes over and the old one is deleted; if it fails, it's
 * deleted instead and the subscriber keeps the old one until the next try.
 */
export const migrate = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const readyToken = secret();
    const linkCode = secret();
    const key = secret(12);
    const job = await ctx.runMutation(internal.servers.claimMove, {
      userId,
      key,
      readyHash: await sha256(readyToken),
      linkHash: await sha256(linkCode),
    });
    if (job) await build(ctx, { userId, key, plan: job.plan, readyToken, linkCode, slot: "next", from: job.from ?? undefined, exclude: job.oldId });
    return null;
  },
});

export const claimMove = internalMutation({
  args: { userId: v.id("users"), key: v.string(), readyHash: v.string(), linkHash: v.string() },
  returns: v.union(v.null(), v.object({ plan: v.string(), oldId: v.string(), from: v.union(v.null(), v.object({ url: v.string(), token: v.string() })) })),
  handler: async (ctx, a) => {
    const row = await subscriberOf(ctx, a.userId);
    const plan = planById(row?.plan);
    const now = Date.now();
    if (!row?.serverId || row.serverStatus !== "ready" || row.nextServerKey || !plan || !hasAccess(row, now)) return null;
    if (rank(plan.id) >= rank(planOfServer(row.serverPlan)?.id)) return null;
    await ctx.db.insert("deviceLinks", { userId: a.userId, codeHash: a.linkHash, expiresAt: now + LINK_MS, serverKey: a.key });
    await ctx.db.patch(row._id, {
      serverStatus: "resizing",
      nextServerKey: a.key,
      serverReadyToken: a.readyHash,
      serverWorkStartedAt: now,
      serverError: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(SETUP_MS, internal.servers.timeout, { userId: a.userId, key: a.key });
    const from = row.serverUrl && row.serverPairingToken ? { url: row.serverUrl, token: row.serverPairingToken } : null;
    return { plan: plan.server, oldId: row.serverId, from };
  },
});

// ----- deleting --------------------------------------------------------------

/**
 * Deletes a subscriber's server(s) because their subscription ended, or with
 * `replace`, to set up a new one (servers:retry). A server Vultr no longer
 * has counts as deleted. Then the server fields are cleared (status none).
 */
export const remove = internalAction({
  args: { userId: v.id("users"), replace: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { userId, replace }) => {
    const job = await ctx.runMutation(internal.servers.claimRemove, { userId, replace: !!replace });
    if (!job) return null;
    const vultr = client();
    try {
      if (!vultr) throw new Error("VULTR_API_KEY isn't set");
      for (const server of job) {
        const gone = !(await vultr.remove(server.id));
        console.log(`Servers: deleted ${userId}'s server ${server.id}${gone ? " (Vultr had already)" : ""}.`);
      }
      await ctx.runMutation(internal.servers.removed, { userId, keys: job.map((s) => s.key).filter((k): k is string => !!k) });
    } catch (err) {
      console.error(`Servers: deleting ${userId}'s server failed: ${message(err)}`);
      await ctx.runMutation(internal.servers.removeFailed, { userId, reason: `Deleting the old computer didn't work: ${message(err)}` });
    }
    return null;
  },
});

export const claimRemove = internalMutation({
  args: { userId: v.id("users"), replace: v.boolean() },
  returns: v.union(v.null(), v.array(v.object({ id: v.string(), key: v.optional(v.string()) }))),
  handler: async (ctx, { userId, replace }) => {
    const row = await subscriberOf(ctx, userId);
    if (!row) return null;
    // Subscribed again meanwhile: the server stays.
    if (!replace && hasAccess(row)) return null;
    const servers = [
      ...(row.serverId ? [{ id: row.serverId, key: row.serverKey }] : []),
      ...(row.nextServerId ? [{ id: row.nextServerId, key: row.nextServerKey }] : []),
    ];
    const now = Date.now();
    if (!servers.length) {
      // Nothing made yet: a setup under way stops (its server is deleted as it's made).
      await ctx.db.patch(row._id, { ...NO_SERVER, ...NO_NEXT, serverStatus: "none", updatedAt: now });
      return null;
    }
    await ctx.db.patch(row._id, { serverStatus: "deleting", serverWorkStartedAt: now, updatedAt: now });
    return servers;
  },
});

export const removed = internalMutation({
  args: { userId: v.id("users"), keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { userId, keys }) => {
    for (const key of keys) await forgetServerSessions(ctx, key);
    const row = await subscriberOf(ctx, userId);
    if (!row) return null;
    await ctx.db.patch(row._id, { ...NO_SERVER, ...NO_NEXT, serverStatus: "none", updatedAt: Date.now() });
    // Set up again (servers:retry), or subscribed again while it was being deleted.
    const updated = await ctx.db.get(row._id);
    if (updated) await planServer(ctx, updated);
    return null;
  },
});

export const removeFailed = internalMutation({
  args: { userId: v.id("users"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, reason }) => {
    const row = await subscriberOf(ctx, userId);
    // Still "deleting": the nightly reconcile tries again.
    if (row?.serverStatus === "deleting") await ctx.db.patch(row._id, { serverError: reason.slice(0, 400), updatedAt: Date.now() });
    return null;
  },
});

/** Deletes one server at Vultr, whoever it belonged to (a replaced server, one
 * no account uses, a deleted account's), and ends its Holly Computer session.
 * Tried again a few times if Vultr can't be reached; the reconcile catches the rest. */
export const destroy = internalAction({
  args: { id: v.string(), key: v.optional(v.string()), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const vultr = client();
    if (!vultr) {
      console.error(`Servers: VULTR_API_KEY isn't set, so server ${a.id} wasn't deleted.`);
      return null;
    }
    try {
      const gone = !(await vultr.remove(a.id));
      console.log(`Servers: deleted server ${a.id}${gone ? " (Vultr had already)" : ""}.`);
    } catch (err) {
      console.error(`Servers: deleting server ${a.id} failed: ${message(err)}`);
      if (a.attempt < 3) await ctx.scheduler.runAfter(5 * 60_000 * (a.attempt + 1), internal.servers.destroy, { ...a, attempt: a.attempt + 1 });
      return null;
    }
    if (a.key) await ctx.runMutation(internal.devices.forgetServer, { key: a.key });
    return null;
  },
});

// ----- the app ----------------------------------------------------------------

/**
 * The app's "Try again" when setting up the server failed (or never
 * started). It can't make or delete a server itself: it schedules the same
 * work Stripe's webhook would, once a minute at most, and only for a paid-up
 * subscriber without a working server. A server left from the failed setup
 * is deleted first.
 */
export const retry = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const row = await subscriberOf(ctx, userId);
    const now = Date.now();
    if (!row || !isPaid(row, now)) throw new ConvexError("There's no subscription to set a computer up for.");
    if (!["error", "none"].includes(row.serverStatus)) return null; // already under way
    if (row.retriedAt && now - row.retriedAt < RETRY_GAP_MS) throw new ConvexError("Holly Bot is already on it. Try again in a minute.");
    await ctx.db.patch(row._id, { retriedAt: now, serverError: undefined, updatedAt: now });
    if (row.serverId || row.nextServerId) await ctx.scheduler.runAfter(0, internal.servers.remove, { userId, replace: true });
    else await ctx.scheduler.runAfter(0, internal.servers.provision, { userId });
    return null;
  },
});

// ----- the nightly reconcile --------------------------------------------------

const row = v.object({
  userId: v.id("users"),
  serverStatus: v.string(),
  serverId: v.optional(v.string()),
  nextServerId: v.optional(v.string()),
  serverKey: v.optional(v.string()),
  serverCreatedAt: v.optional(v.number()),
  serverWorkStartedAt: v.optional(v.number()),
  plan: v.optional(v.string()),
  serverPlan: v.optional(v.string()),
  subscriptionStatus: v.optional(v.string()),
  /** Moving to a smaller server (a downgrade under way). */
  moving: v.boolean(),
  access: v.boolean(),
  paid: v.boolean(),
});

export const everyone = internalQuery({
  args: {},
  returns: v.array(row),
  handler: async (ctx) => {
    const now = Date.now();
    return (await ctx.db.query("subscribers").collect()).map((r) => ({
      userId: r.userId,
      serverStatus: r.serverStatus,
      serverId: r.serverId,
      nextServerId: r.nextServerId,
      serverKey: r.serverKey,
      serverCreatedAt: r.serverCreatedAt,
      serverWorkStartedAt: r.serverWorkStartedAt,
      plan: r.plan,
      serverPlan: r.serverPlan,
      subscriptionStatus: r.subscriptionStatus,
      moving: !!r.nextServerKey,
      access: hasAccess(r, now),
      paid: isPaid(r, now),
    }));
  },
});

/** A server the account's record points at, but Vultr no longer has. */
export const lost = internalMutation({
  args: { userId: v.id("users"), id: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, id }) => {
    const r = await subscriberOf(ctx, userId);
    if (!r || r.serverId !== id) return null;
    await ctx.db.patch(r._id, { ...NO_SERVER, ...NO_NEXT, serverStatus: "none", updatedAt: Date.now() });
    const updated = await ctx.db.get(r._id);
    if (updated) await planServer(ctx, updated);
    return null;
  },
});

/**
 * Every night: compares the servers at Vultr (tag holly-customer) with the
 * subscribers. Deletes a server whose subscriber has no active or past-due
 * subscription, or that no account uses; sets one up for a paid subscriber
 * without one; finishes a plan change that didn't happen; and logs what it
 * changed.
 */
export const reconcile = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const vultr = client();
    if (!vultr) {
      console.log("Reconcile: VULTR_API_KEY isn't set, so there are no servers to check.");
      return null;
    }
    const startedAt = Date.now();
    const rows = await ctx.runQuery(internal.servers.everyone, {});
    let instances: Instance[];
    try {
      instances = await vultr.list({ tag: SERVERS.tag });
    } catch (err) {
      console.error(`Reconcile: couldn't list the servers at Vultr: ${message(err)}`);
      return null;
    }
    // A dry run has no servers at Vultr: the made-up ones stand in.
    if (vultr.dryRun) {
      for (const id of rows.flatMap((r) => [r.serverId, r.nextServerId])) {
        if (id?.startsWith("dry-")) instances.push({ id, label: "(dry run)", tags: [SERVERS.tag], plan: "", ip: "", status: "active", power: "running", state: "ok" });
      }
    }
    const owner = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (r.serverId) owner.set(r.serverId, r);
      if (r.nextServerId) owner.set(r.nextServerId, r);
    }
    // Servers being made right now may not have their id kept yet.
    const busy = new Set(rows.filter((r) => r.serverStatus === "provisioning" || r.serverStatus === "resizing").map((r) => labelOf(r.userId)));
    const atVultr = new Set(instances.map((i) => i.id));
    const changes: string[] = [];
    const removing = new Set<string>();
    for (const i of instances) {
      const r = owner.get(i.id);
      if (!r && busy.has(i.label)) {
        changes.push(`leaving ${i.label} (${i.id}) alone: it's being set up`);
      } else if (!r) {
        await ctx.scheduler.runAfter(0, internal.servers.destroy, { id: i.id, attempt: 0 });
        changes.push(`deleting ${i.label || i.id} (${i.id}): no account uses it`);
      } else if (!r.access && !removing.has(r.userId)) {
        removing.add(r.userId);
        await ctx.scheduler.runAfter(0, internal.servers.remove, { userId: r.userId });
        changes.push(`deleting ${r.userId}'s server ${i.id}: the subscription is ${r.subscriptionStatus || "gone"}`);
      }
    }
    /** Work on a server that started over `ms` ago and hasn't finished. */
    const stalled = (r: (typeof rows)[number], ms = 10 * 60_000) => (r.serverWorkStartedAt ?? 0) < startedAt - ms;
    for (const r of rows) {
      if (removing.has(r.userId)) continue;
      const old = (r.serverCreatedAt ?? startedAt) < startedAt - 10 * 60_000;
      const dryId = r.serverId?.startsWith("dry-");
      if (r.serverId && !atVultr.has(r.serverId) && old && (!vultr.dryRun || dryId) && r.serverStatus !== "deleting") {
        await ctx.runMutation(internal.servers.lost, { userId: r.userId, id: r.serverId });
        changes.push(`${r.userId}'s server ${r.serverId} is gone at Vultr${r.paid ? "; setting up another" : ""}`);
      } else if (r.paid && !r.serverId && ["none", "error"].includes(r.serverStatus)) {
        await ctx.scheduler.runAfter(0, internal.servers.provision, { userId: r.userId });
        changes.push(`setting up a server for ${r.userId}, who has none`);
      } else if (r.serverStatus === "provisioning" && r.serverKey && (r.serverWorkStartedAt ?? 0) < startedAt - 60 * 60_000) {
        await ctx.runMutation(internal.servers.failed, { userId: r.userId, key: r.serverKey, reason: "Setting up your computer stopped partway." });
        changes.push(`${r.userId}'s setup stalled; marked failed`);
      } else if (r.access && r.serverId && r.serverStatus === "ready" && !r.nextServerId) {
        const want = rank(r.plan);
        const have = rank(planOfServer(r.serverPlan)?.id);
        if (want >= 0 && have >= 0 && want !== have) {
          await ctx.scheduler.runAfter(0, want > have ? internal.servers.resize : internal.servers.migrate, { userId: r.userId });
          changes.push(`${want > have ? "upgrading" : "moving"} ${r.userId}'s server to ${r.plan}`);
        }
      } else if (r.serverStatus === "deleting" && stalled(r)) {
        // A deletion that didn't finish (Vultr refused, or it stopped partway)
        // goes again. A server Vultr no longer has counts as deleted.
        await ctx.scheduler.runAfter(0, internal.servers.remove, { userId: r.userId, replace: r.access });
        changes.push(`deleting ${r.userId}'s server again`);
      } else if (r.serverStatus === "resizing" && r.serverId && !r.moving && stalled(r, 2 * RESIZE_MS)) {
        // An upgrade no longer being checked on: one last look settles it.
        const plan = planById(r.plan)?.server ?? "";
        await ctx.scheduler.runAfter(0, internal.servers.watchResize, { userId: r.userId, id: r.serverId, plan, startedAt: r.serverWorkStartedAt ?? 0 });
        changes.push(`checking on ${r.userId}'s upgrade, which stalled`);
      }
    }
    const dry = vultr.dryRun ? " (dry run)" : "";
    console.log(`Reconcile${dry}: ${instances.length} ${SERVERS.tag} servers, ${rows.length} subscribers. ${changes.length ? changes.join("; ") : "Nothing to change."}`);
    return null;
  },
});
