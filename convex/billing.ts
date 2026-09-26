import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { isAllowedRedirect } from "./auth";
import { requireUserId } from "./lib/auth";
import { PLANS, planById, priceVariable, type Interval, type Plan, type PlanId } from "./lib/plans";
import { StripeError, call, subscriptionState, verifySignature, type SubscriptionState } from "./lib/stripe";
import { storeSession } from "./lib/store";
import { ENDED, hasAccess, isExempt, liveMode, needsCheck, subscriberOf } from "./lib/subscription";
import { planServer, serverView } from "./servers";

// Subscriptions. Holli Bot opens only for an account whose subscription is
// active (or past due, while Stripe tries the card again), or that's exempt
// (the owner's, while testing): the app sends everyone else to its
// subscription page (src/main.js), and the server keeps and uses an account's
// data only for them (convex/lib/subscription.ts).
// People pick a plan and pay on Stripe Checkout (mode=subscription), and
// manage it in Stripe's billing portal. Each subscriber's record in
// `subscribers` also holds their dedicated server (convex/servers.ts).
//
// Stripe's webhook (/stripe/webhook) drives everything that follows a
// payment: it keeps the subscription in step and schedules the subscriber's
// server being made, resized or deleted. Each event is handled once (its id is
// kept in `stripeEvents`). The app also asks Stripe directly when it comes
// back from Checkout or the portal (`sync`), so the subscription page knows
// straight away; that never touches servers.
//
// Variables (CONVEX.md): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and each
// plan's price ids, STRIPE_PRICE_<PLAN>_MONTHLY and _YEARLY (convex/lib/plans.ts).

const NOT_SET_UP = "Subscriptions aren't set up on Holli Bot's server yet.";
/** Deleting a customer is retried this long after an account is deleted. */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
/** Handled events are remembered this long (Stripe retries for three days). */
const EVENT_DAYS = 30;

export const secretKey = () => process.env.STRIPE_SECRET_KEY?.trim() || undefined;
export const modeOf = (key: string) => (/_live_/.test(key) ? "live" : "test");
const interval = v.union(v.literal("month"), v.literal("year"));
const INTERVALS: Interval[] = ["month", "year"];

/** A plan's Stripe price id, from its deployment variable. */
function priceId(plan: PlanId, every: Interval): string | undefined {
  return process.env[priceVariable(plan, every)]?.trim() || undefined;
}

/** The plan a Stripe price id is set for. */
function planOfPrice(id: string | undefined): PlanId | undefined {
  if (!id) return undefined;
  return PLANS.find((plan) => INTERVALS.some((every) => priceId(plan.id, every) === id))?.id;
}

/** Stripe's key and every plan's prices are set. */
const configured = () => !!secretKey() && PLANS.every((plan) => INTERVALS.every((every) => priceId(plan.id, every)));

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const planInfo = v.object({
  id: v.string(),
  name: v.string(),
  note: v.optional(v.string()),
  cpu: v.number(),
  memoryGb: v.number(),
  price: v.object({ month: v.number(), year: v.number() }),
  /** Its AI credits every month (1 per US cent of DeepSeek use: convex/credits.ts). */
  credits: v.number(),
});

/**
 * What the app knows about the account's subscription and server. `active`:
 * it may use Holli Bot (paid up, or `pastDue` while Stripe tries the card
 * again, or `exempt`: it needs no subscription, and has no server). `ready`:
 * Stripe is set up. `check`: a paid period should have ended by now without
 * word from Stripe, so ask it (`sync`).
 */
const statusInfo = v.object({
  active: v.boolean(),
  pastDue: v.boolean(),
  exempt: v.boolean(),
  ready: v.boolean(),
  check: v.boolean(),
  plans: v.array(planInfo),
  subscription: v.union(
    v.null(),
    v.object({
      plan: v.optional(v.string()),
      interval: v.optional(v.string()),
      status: v.string(),
      periodEnd: v.optional(v.number()),
      endsAt: v.optional(v.number()),
    }),
  ),
  server: v.union(
    v.null(),
    v.object({
      status: v.string(),
      step: v.optional(v.string()),
      since: v.optional(v.number()),
      error: v.optional(v.string()),
      ip: v.optional(v.string()),
      plan: v.optional(v.string()),
    }),
  ),
});
type Status = Infer<typeof statusInfo>;

/** The account's record, if it belongs to the current Stripe mode. */
function inMode(row: Doc<"subscribers"> | null): Doc<"subscribers"> | null {
  const live = liveMode();
  return row && (live === undefined || row.livemode === live) ? row : null;
}

async function describe(ctx: QueryCtx, userId: Id<"users">): Promise<Status> {
  const now = Date.now();
  const row = await subscriberOf(ctx, userId);
  const sub = inMode(row)?.stripeSubscriptionId ? inMode(row) : null;
  const paid = hasAccess(row, now);
  const exempt = !paid && (await isExempt(ctx, userId));
  return {
    active: paid || exempt,
    pastDue: paid && row?.subscriptionStatus === "past_due",
    exempt,
    ready: configured(),
    check: needsCheck(row, now),
    plans: PLANS.map(({ id, name, note, cpu, memoryGb, price, credits }) => ({ id, name, note, cpu, memoryGb, price: { ...price }, credits })),
    subscription: sub
      ? { plan: sub.plan, interval: sub.billingInterval, status: sub.subscriptionStatus ?? "", periodEnd: sub.currentPeriodEnd, endsAt: sub.cancelAt }
      : null,
    server: row ? serverView(row) : null,
  };
}

/** The signed-in account's subscription and server, and the plans on offer. */
export const status = query({
  args: {},
  returns: statusInfo,
  handler: async (ctx) => describe(ctx, await requireUserId(ctx)),
});

export const statusOf = internalQuery({
  args: { userId: v.id("users") },
  returns: statusInfo,
  handler: async (ctx, { userId }) => describe(ctx, userId),
});

/** The signed-in account, for the actions below (their sign-in passes to
 * what they run). `open`: the status of a subscription that isn't over but
 * doesn't let it in (unpaid, incomplete, paused). */
export const mine = internalQuery({
  args: {},
  returns: v.object({
    userId: v.id("users"),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    customerId: v.optional(v.string()),
    access: v.boolean(),
    open: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get(userId);
    const row = await subscriberOf(ctx, userId);
    const same = inMode(row);
    const access = hasAccess(row);
    const status = same?.stripeSubscriptionId ? same.subscriptionStatus : undefined;
    return {
      userId,
      email: user?.email || undefined,
      name: user?.name?.trim().slice(0, 60) || undefined,
      customerId: same?.stripeCustomerId,
      access,
      open: !access && status && !ENDED.has(status) ? status : undefined,
    };
  },
});

/** Keeps the Stripe customer just made for the signed-in account, or hands
 * back the one another checkout made first. A customer from the other Stripe
 * mode is replaced (it means nothing in this one). */
export const saveCustomer = internalMutation({
  args: { customerId: v.string(), livemode: v.boolean() },
  returns: v.string(),
  handler: async (ctx, { customerId, livemode }) => {
    const userId = await requireUserId(ctx);
    const row = await subscriberOf(ctx, userId);
    const now = Date.now();
    if (!row) {
      await ctx.db.insert("subscribers", { userId, livemode, stripeCustomerId: customerId, serverStatus: "none", updatedAt: now });
      return customerId;
    }
    if (row.livemode === livemode && row.stripeCustomerId) return row.stripeCustomerId;
    await ctx.db.patch(row._id, {
      livemode,
      stripeCustomerId: customerId,
      stripeSubscriptionId: undefined,
      plan: undefined,
      billingInterval: undefined,
      subscriptionStatus: undefined,
      currentPeriodEnd: undefined,
      cancelAt: undefined,
      updatedAt: now,
    });
    return customerId;
  },
});

/** Forgets a customer Stripe no longer has (deleted in its dashboard, test
 * data cleared), with its subscription. The server follows at the nightly
 * reconcile. */
export const dropCustomer = internalMutation({
  args: { customerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { customerId }) => {
    for (const row of await ctx.db.query("subscribers").withIndex("by_customer", (q) => q.eq("stripeCustomerId", customerId)).collect()) {
      await ctx.db.patch(row._id, {
        stripeCustomerId: undefined,
        stripeSubscriptionId: undefined,
        subscriptionStatus: undefined,
        currentPeriodEnd: undefined,
        cancelAt: undefined,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

const subscriptionInfo = v.object({
  subscriptionId: v.string(),
  customerId: v.string(),
  status: v.string(),
  livemode: v.boolean(),
  priceId: v.optional(v.string()),
  interval: v.optional(v.string()),
  periodEnd: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  userId: v.optional(v.string()),
  plan: v.optional(v.string()),
});

/** The subscriber a Stripe customer belongs to: the account the customer was
 * made for, or else the account named at checkout, which gets a record. */
async function subscriberFor(ctx: MutationCtx, sub: SubscriptionState, hint: string | undefined): Promise<Doc<"subscribers"> | null> {
  const known = await ctx.db.query("subscribers").withIndex("by_customer", (q) => q.eq("stripeCustomerId", sub.customerId)).first();
  if (known) return known;
  const userId = ctx.db.normalizeId("users", hint ?? sub.userId ?? "");
  if (!userId || !(await ctx.db.get(userId))) return null; // an account deleted since, or not Holli Bot's
  const row = await subscriberOf(ctx, userId);
  if (row) {
    await ctx.db.patch(row._id, { stripeCustomerId: sub.customerId, livemode: sub.livemode });
    return await ctx.db.get(row._id);
  }
  const id = await ctx.db.insert("subscribers", { userId, livemode: sub.livemode, stripeCustomerId: sub.customerId, serverStatus: "none", updatedAt: Date.now() });
  return await ctx.db.get(id);
}

/**
 * Keeps a subscription as Stripe describes it, on its subscriber's record.
 * The record follows one subscription: this one if it's the same, or if the
 * one it had is over; an old subscription that ended doesn't touch a newer
 * one. With `event`, it's handled once: its id is kept, and a repeat is
 * skipped. With `servers` (the webhook), the subscriber's server is then
 * made, resized, moved or, when `ended`, deleted to match.
 */
export const record = internalMutation({
  args: {
    sub: subscriptionInfo,
    userHint: v.optional(v.string()),
    event: v.optional(v.object({ id: v.string(), type: v.string() })),
    servers: v.boolean(),
    ended: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { sub, userHint, event, servers, ended }) => {
    if (event) {
      if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", event.id)).first()) return "repeat";
      await ctx.db.insert("stripeEvents", { eventId: event.id, type: event.type, processedAt: Date.now() });
    }
    const row = await subscriberFor(ctx, sub, userHint);
    if (!row) return "not ours";
    const sameMode = row.livemode === sub.livemode;
    const theirs = sameMode && row.stripeSubscriptionId;
    if (theirs && theirs !== sub.subscriptionId) {
      const currentOver = !row.subscriptionStatus || ENDED.has(row.subscriptionStatus);
      if (ENDED.has(sub.status) || !currentOver) {
        if (!ENDED.has(sub.status)) console.warn(`Billing: ${row.userId} has two subscriptions going (${theirs} and ${sub.subscriptionId}); following ${theirs}. Cancel one in Stripe.`);
        return "other subscription";
      }
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      livemode: sub.livemode,
      stripeCustomerId: sub.customerId,
      stripeSubscriptionId: sub.subscriptionId,
      // The price says which plan; the checkout's metadata is the fallback.
      plan: planOfPrice(sub.priceId) ?? planById(sub.plan)?.id ?? row.plan,
      billingInterval: sub.interval ?? row.billingInterval,
      subscriptionStatus: sub.status,
      currentPeriodEnd: sub.periodEnd,
      cancelAt: sub.endsAt,
      updatedAt: now,
    });
    if (!planOfPrice(sub.priceId) && sub.priceId) console.warn(`Billing: ${sub.subscriptionId} is on price ${sub.priceId}, which no STRIPE_PRICE_* variable names.`);
    const updated = await ctx.db.get(row._id);
    if (servers && updated) await planServer(ctx, updated, { ended: !!ended });
    return "ok";
  },
});

export const seen = internalQuery({
  args: { eventId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { eventId }) => !!(await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", eventId)).first()),
});

/** Forgets handled events older than EVENT_DAYS (convex/crons.ts). */
export const sweepEvents = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("stripeEvents")
      .withIndex("by_time", (q) => q.lt("processedAt", Date.now() - EVENT_DAYS * 86_400_000))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.billing.sweepEvents, {});
    return null;
  },
});

/** A problem at Stripe, in words for the app; the details go to the log. */
export function asError(err: unknown, fallback: string): ConvexError<string> {
  if (err instanceof ConvexError) return err;
  console.error(`Stripe: ${err instanceof Error ? err.message : String(err)}`);
  return new ConvexError(fallback);
}

export const missingCustomer = (err: unknown) => err instanceof StripeError && err.code === "resource_missing" && /customer/i.test(err.message);

/** Where Stripe sends the person back to: the app, with what happened. */
export function backTo(returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo);
  url.hash = "";
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

export async function newCustomer(ctx: ActionCtx, key: string, me: { userId: string; email?: string; name?: string }, again = false): Promise<string> {
  const customer = await call(
    key,
    "POST",
    "/customers",
    { email: me.email, name: me.name, metadata: { userId: me.userId } },
    // Two checkouts started at once make one customer. Not when the last one
    // went missing: that would hand it back again.
    { idempotencyKey: again ? undefined : `holly-bot-customer-${modeOf(key)}-${me.userId}` },
  );
  return await ctx.runMutation(internal.billing.saveCustomer, { customerId: customer.id, livemode: !!customer.livemode });
}

/** The Stripe customer made for an account, found by its metadata (Stripe's
 * search can take a minute to see a new one). */
async function customerFor(key: string, userId: string): Promise<string | undefined> {
  try {
    const found = await call(key, "GET", "/customers/search", { query: `metadata['userId']:'${userId}'`, limit: 1 });
    return found?.data?.[0]?.id;
  } catch (err) {
    console.warn(`Stripe: looking for ${userId}'s customer: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Checks that a plan's Stripe price is what the subscription page shows
 * (convex/lib/plans.ts), so nobody is charged a different amount. */
async function checkPrice(key: string, plan: Plan, every: Interval, id: string) {
  const price = await call(key, "GET", `/prices/${encodeURIComponent(id)}`);
  const amount = plan.price[every];
  const recurring = price?.recurring;
  if (price?.active && price.currency === "usd" && price.unit_amount === amount && recurring?.interval === every && (recurring?.interval_count ?? 1) === 1 && recurring?.usage_type !== "metered") return;
  const has = price ? `${price.active ? "" : "archived, "}${price.unit_amount ?? "?"} ${price.currency ?? "?"} every ${recurring?.interval_count ?? 1} ${recurring?.interval ?? "?"}` : "missing";
  console.error(`Checkout: ${priceVariable(plan.id, every)} (${id}) is ${has}, but convex/lib/plans.ts charges ${money(amount)} every ${every}. Make them match.`);
  throw new ConvexError("That plan's price isn't set up right on Holli Bot's server yet.");
}

/**
 * Starts a subscription: the address of Stripe Checkout (mode=subscription)
 * for a plan, billed monthly or yearly. Stripe sends the person back to
 * `returnTo` with ?checkout=done or ?checkout=cancelled. An account that
 * already has a subscription that isn't over can't start a second one.
 */
export const checkout = action({
  args: { plan: v.string(), interval, returnTo: v.string() },
  returns: v.string(),
  handler: async (ctx, { plan: planId, interval: every, returnTo }): Promise<string> => {
    const me = await ctx.runQuery(internal.billing.mine, {});
    const key = secretKey();
    if (!key) throw new ConvexError(NOT_SET_UP);
    const plan = planById(planId);
    if (!plan) throw new ConvexError("That plan isn't offered.");
    const price = priceId(plan.id, every);
    if (!price) {
      console.error(`Checkout: ${priceVariable(plan.id, every)} isn't set.`);
      throw new ConvexError("That plan isn't set up on Holli Bot's server yet.");
    }
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holli Bot can't come back to that address.");
    if (me.access) throw new ConvexError("This account already has a subscription.");
    if (me.open) throw new ConvexError("Your subscription needs attention first. Update your payment method in billing.");
    const start = async (customer: string): Promise<string> => {
      const session = await call(key, "POST", "/checkout/sessions", {
        mode: "subscription",
        customer,
        client_reference_id: me.userId,
        line_items: [{ price, quantity: 1 }],
        // Promotion codes made in Stripe's dashboard (Product catalog → Coupons).
        allow_promotion_codes: true,
        success_url: backTo(returnTo, { checkout: "done" }),
        cancel_url: backTo(returnTo, { checkout: "cancelled" }),
        metadata: { userId: me.userId, plan: plan.id },
        subscription_data: { metadata: { userId: me.userId, plan: plan.id } },
        custom_text: {
          submit: { message: `Renews automatically every ${every} until you cancel. Cancel anytime in Holli Bot: Settings → Subscription.` },
        },
      });
      if (!session?.url) throw new Error("Stripe didn't return a checkout page");
      return session.url;
    };
    try {
      await checkPrice(key, plan, every, price);
      let customer = me.customerId;
      if (!customer) {
        // A customer made for this account that its record doesn't know (by
        // version 1.7, which kept them elsewhere), maybe with a subscription
        // still going: that one is used, and never a second subscription.
        const earlier = await customerFor(key, me.userId);
        if (earlier) {
          customer = await ctx.runMutation(internal.billing.saveCustomer, { customerId: earlier, livemode: modeOf(key) === "live" });
          const list = await call(key, "GET", "/subscriptions", { customer, status: "all", limit: 20 });
          const going = (list?.data ?? []).map(subscriptionState).find((s: SubscriptionState) => !ENDED.has(s.status));
          if (going) {
            await ctx.runMutation(internal.billing.record, { sub: going, servers: false });
            return backTo(returnTo, { checkout: "done" });
          }
        }
      }
      customer ??= await newCustomer(ctx, key, me);
      try {
        return await start(customer);
      } catch (err) {
        if (!missingCustomer(err)) throw err;
        await ctx.runMutation(internal.billing.dropCustomer, { customerId: customer });
        return await start(await newCustomer(ctx, key, me, true));
      }
    } catch (err) {
      throw asError(err, "Couldn't start checkout. Try again in a minute.");
    }
  },
});

/** Stripe's billing portal for the account: change plan, update the card,
 * see invoices, cancel. It sends the person back with ?billing=done. */
export const portal = action({
  args: { returnTo: v.string() },
  returns: v.string(),
  handler: async (ctx, { returnTo }): Promise<string> => {
    const me = await ctx.runQuery(internal.billing.mine, {});
    const key = secretKey();
    if (!key) throw new ConvexError(NOT_SET_UP);
    if (!me.customerId) throw new ConvexError("There's no subscription to manage yet.");
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holli Bot can't come back to that address.");
    try {
      const session = await call(key, "POST", "/billing_portal/sessions", { customer: me.customerId, return_url: backTo(returnTo, { billing: "done" }) });
      return session.url;
    } catch (err) {
      if (!missingCustomer(err)) throw asError(err, "Couldn't open billing. Try again in a minute.");
      await ctx.runMutation(internal.billing.dropCustomer, { customerId: me.customerId });
      throw new ConvexError("There's no subscription to manage yet.");
    }
  },
});

/** Asks Stripe for the account's subscription and keeps what it says, then
 * says where the account stands: after Checkout or the portal, and when a
 * paid period should have ended. Servers are left to the webhook. */
export const sync = action({
  args: {},
  returns: statusInfo,
  handler: async (ctx): Promise<Status> => {
    const me = await ctx.runQuery(internal.billing.mine, {});
    const key = secretKey();
    if (key && me.customerId) {
      try {
        const list = await call(key, "GET", "/subscriptions", { customer: me.customerId, status: "all", limit: 20 });
        const subs = (list?.data ?? []).map(subscriptionState);
        // The one that matters: one that isn't over, else the newest.
        const sub = subs.find((s: SubscriptionState) => !ENDED.has(s.status)) ?? subs[0];
        if (sub) await ctx.runMutation(internal.billing.record, { sub, servers: false });
      } catch (err) {
        if (missingCustomer(err)) await ctx.runMutation(internal.billing.dropCustomer, { customerId: me.customerId });
        else console.error(`Stripe: ${err instanceof Error ? err.message : String(err)}`); // what's kept stands
      }
    }
    return await ctx.runQuery(internal.billing.statusOf, { userId: me.userId });
  },
});

const reply = (text: string, status = 200) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const idOf = (value: any): string | undefined => (typeof value === "string" ? value : value?.id) || undefined;

/**
 * Stripe's webhook (convex/http.ts routes POST /stripe/webhook here), signed
 * with STRIPE_WEBHOOK_SECRET; anything unsigned or signed wrong is refused.
 * Each event is handled once. The subscription it's about is read from Stripe
 * again, so events that arrive late or out of order can't undo a newer change:
 *   checkout.session.completed      the subscriber's record, and their server made
 *   customer.subscription.created   kept in step (and a server, if paid and none)
 *   customer.subscription.updated   kept in step; a bigger plan resizes the server,
 *                                   a smaller one moves it to a smaller server
 *   invoice.payment_failed          past due: the server stays, and the app asks
 *                                   for a new card
 *   customer.subscription.deleted   canceled: the server is deleted
 * and a Bot Store purchase (checkout.session.completed, mode=payment):
 * the bot is the buyer's (convex/store.ts record).
 * Answering with an error makes Stripe try again later.
 */
export const webhook = httpAction(async (ctx, request) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const key = secretKey();
  if (!secret || !key) return reply(NOT_SET_UP, 503);
  const body = await request.text();
  if (!(await verifySignature(body, request.headers.get("stripe-signature"), secret))) return reply("Bad signature", 400);
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return reply("Bad payload", 400);
  }
  const live = modeOf(key) === "live";
  if (!!event?.livemode !== live) {
    console.warn(`Stripe webhook: ignored a ${event?.livemode ? "live" : "test"}-mode ${event?.type}; STRIPE_SECRET_KEY is a ${live ? "live" : "test"} key.`);
    return reply("ok");
  }
  const id = String(event?.id ?? "");
  const type = String(event?.type ?? "");
  if (!id || (await ctx.runQuery(internal.billing.seen, { eventId: id }))) return reply("ok");
  const object = event?.data?.object ?? {};
  // A Bot Store purchase (convex/store.ts): the bot is the buyer's once it's
  // paid for, which a card or wallet payment is as the session completes.
  const bought = (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") ? storeSession(object) : null;
  if (bought) {
    if (!bought.paid) return reply("ok");
    try {
      const result = await ctx.runMutation(internal.store.record, { purchase: bought, event: { id, type } });
      if (result !== "ok" && result !== "repeat" && result !== "known") console.log(`Stripe webhook ${type} ${id}: ${result}`);
    } catch (err) {
      console.error(`Stripe webhook ${type} ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return reply("Try again later", 500);
    }
    return reply("ok");
  }
  let subscriptionId: string | undefined;
  let userHint: string | undefined;
  if (type === "checkout.session.completed") {
    if (object.mode !== "subscription") return reply("ok");
    subscriptionId = idOf(object.subscription);
    userHint = object.client_reference_id || object.metadata?.userId || undefined;
  } else if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    subscriptionId = idOf(object.id);
  } else if (type === "invoice.payment_failed") {
    subscriptionId = idOf(object.subscription ?? object.parent?.subscription_details?.subscription);
  }
  if (!subscriptionId) return reply("ok");
  try {
    const sub = subscriptionState(await call(key, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`));
    const result = await ctx.runMutation(internal.billing.record, {
      sub,
      userHint,
      event: { id, type },
      servers: true,
      ended: type === "customer.subscription.deleted" || ENDED.has(sub.status),
    });
    if (result !== "ok" && result !== "repeat") console.log(`Stripe webhook ${type} ${id}: ${result}`);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return reply("ok"); // gone (test data cleared)
    console.error(`Stripe webhook ${type} ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return reply("Try again later", 500);
  }
  return reply("ok");
});

/** Deletes an account's customer at Stripe after the account is deleted
 * (account:deleteAccount), which cancels its subscription at once. Tries
 * again for most of a day if Stripe can't be reached. */
export const forget = internalAction({
  args: { customerId: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { customerId, attempt }) => {
    const key = secretKey();
    if (!key) return null;
    try {
      await call(key, "DELETE", `/customers/${encodeURIComponent(customerId)}`);
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) return null; // already gone
      console.error(`Deleting Stripe customer ${customerId}: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < RETRY_MS.length) await ctx.scheduler.runAfter(RETRY_MS[attempt], internal.billing.forget, { customerId, attempt: attempt + 1 });
    }
    return null;
  },
});
