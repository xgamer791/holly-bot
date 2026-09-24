import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { isAllowedRedirect } from "./auth";
import { requireUserId } from "./lib/auth";
import { PLANS, planById, planOfProduct, priceKey, productId, type Interval, type Plan } from "./lib/plans";
import { StripeError, call, subscriptionState, verifySignature } from "./lib/stripe";
import { ENDED, customerOf, isActive, needsCheck, subscriptionsOf } from "./lib/subscription";

// Subscriptions. Holly Bot opens only for an account with an active one: the
// app sends everyone else to its subscription page (src/main.js), and the
// server keeps and uses an account's data only while it's active
// (convex/lib/subscription.ts). People pick a plan and pay on Stripe Checkout
// (mode=subscription), and manage it in Stripe's billing portal.
//
// Stripe tells this deployment about every change through its webhook
// (/stripe/webhook, convex/http.ts). The app also asks Stripe directly when it
// comes back from Checkout or the portal, and when a paid period should have
// ended (`sync`), so a subscription opens Holly Bot the moment it's paid for,
// and a late or missing webhook can't keep it open or shut.
//
// Variables (CONVEX.md): STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. The
// plans' products and prices at Stripe are made here the first time someone
// subscribes (convex/lib/plans.ts sets the prices).

const NOT_SET_UP = "Subscriptions aren't set up on Holly Bot's server yet.";
/** Deleting a customer is retried this long after an account is deleted. */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];

const secretKey = () => process.env.STRIPE_SECRET_KEY?.trim() || undefined;
const modeOf = (key: string) => (/_live_/.test(key) ? "live" : "test");
const interval = v.union(v.literal("month"), v.literal("year"));

const planInfo = v.object({
  id: v.string(),
  name: v.string(),
  note: v.optional(v.string()),
  cpu: v.number(),
  memoryGb: v.number(),
  price: v.object({ month: v.number(), year: v.number() }),
});

/** What the app knows about the account's subscription. `check`: a paid
 * period should have ended by now without word from Stripe, so ask it (`sync`). */
const statusInfo = v.object({
  active: v.boolean(),
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
});
type Status = Infer<typeof statusInfo>;

const subscriptionInfo = v.object({
  subscriptionId: v.string(),
  customerId: v.string(),
  status: v.string(),
  priceId: v.optional(v.string()),
  productId: v.optional(v.string()),
  interval: v.optional(v.string()),
  periodEnd: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  userId: v.optional(v.string()),
});

/** The subscription that decides what the account can do: an active one,
 * else one that isn't over (a payment that didn't go through), else the
 * latest to end. */
function current(subs: Doc<"subscriptions">[], now: number): Doc<"subscriptions"> | null {
  const rank = (sub: Doc<"subscriptions">) => (isActive(sub, now) ? 2 : ENDED.has(sub.status) ? 0 : 1);
  const sorted = [...subs].sort((a, b) => rank(b) - rank(a) || (b.periodEnd ?? 0) - (a.periodEnd ?? 0) || b._creationTime - a._creationTime);
  return sorted[0] ?? null;
}

async function describe(ctx: QueryCtx, userId: Id<"users">): Promise<Status> {
  const now = Date.now();
  const sub = current(await subscriptionsOf(ctx, userId), now);
  return {
    active: !!sub && isActive(sub, now),
    ready: !!secretKey(),
    check: !!sub && needsCheck(sub, now),
    plans: PLANS.map(({ id, name, note, cpu, memoryGb, price }) => ({ id, name, note, cpu, memoryGb, price: { ...price } })),
    subscription: sub ? { plan: sub.plan, interval: sub.interval, status: sub.status, periodEnd: sub.periodEnd, endsAt: sub.endsAt } : null,
  };
}

/** The signed-in account's subscription, and the plans on offer. */
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

/** The signed-in account, for the actions below (their sign-in passes to what
 * they run). `open`: the status of a subscription that isn't over, if any. */
export const mine = internalQuery({
  args: {},
  returns: v.object({
    userId: v.id("users"),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    customerId: v.optional(v.string()),
    open: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get(userId);
    const customer = await customerOf(ctx, userId);
    const open = (await subscriptionsOf(ctx, userId)).find((sub) => !ENDED.has(sub.status));
    return {
      userId,
      email: user?.email || undefined,
      name: user?.name?.trim().slice(0, 60) || undefined,
      customerId: customer?.customerId,
      open: open?.status,
    };
  },
});

/** Keeps the customer just made at Stripe for the signed-in account, or, if
 * another checkout made one first, hands that one back instead. */
export const saveCustomer = internalMutation({
  args: { customerId: v.string(), livemode: v.boolean() },
  returns: v.string(),
  handler: async (ctx, { customerId, livemode }) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db.query("billingCustomers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const existing = rows.find((row) => row.livemode === livemode);
    if (existing) return existing.customerId;
    await ctx.db.insert("billingCustomers", { userId, customerId, livemode });
    return customerId;
  },
});

/** Forgets a customer Stripe no longer has (deleted in its dashboard, test
 * data cleared), and its subscriptions with it. */
export const dropCustomer = internalMutation({
  args: { customerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { customerId }) => {
    for (const row of await ctx.db.query("billingCustomers").withIndex("by_customer", (q) => q.eq("customerId", customerId)).collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("subscriptions").withIndex("by_customer", (q) => q.eq("customerId", customerId)).collect()) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Keeps subscriptions as Stripe describes them. Each belongs to the account
 * its customer was made for; failing that, to the account named at checkout
 * (`userHint`, or the subscription's metadata), which then gets the customer
 * too. One for an account that no longer exists is ignored.
 */
export const save = internalMutation({
  args: { subs: v.array(subscriptionInfo), livemode: v.boolean(), userHint: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { subs, livemode, userHint }) => {
    for (const sub of subs) {
      if (!sub.subscriptionId || !sub.customerId) continue;
      const customer = await ctx.db.query("billingCustomers").withIndex("by_customer", (q) => q.eq("customerId", sub.customerId)).first();
      let userId = customer?.userId ?? null;
      if (!userId) {
        const named = ctx.db.normalizeId("users", userHint ?? sub.userId ?? "");
        if (!named || !(await ctx.db.get(named))) continue;
        userId = named;
        await ctx.db.insert("billingCustomers", { userId, customerId: sub.customerId, livemode });
      }
      const row = {
        userId,
        customerId: sub.customerId,
        subscriptionId: sub.subscriptionId,
        status: sub.status,
        plan: planOfProduct(sub.productId)?.id,
        interval: sub.interval,
        priceId: sub.priceId,
        periodEnd: sub.periodEnd,
        endsAt: sub.endsAt,
        livemode,
        updatedAt: Date.now(),
      };
      const existing = await ctx.db.query("subscriptions").withIndex("by_subscription", (q) => q.eq("subscriptionId", sub.subscriptionId)).unique();
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("subscriptions", row);
    }
    return null;
  },
});

/** A problem at Stripe, in words for the app; the details go to the log. */
function asError(err: unknown, fallback: string): ConvexError<string> {
  if (err instanceof ConvexError) return err;
  console.error(`Stripe: ${err instanceof Error ? err.message : String(err)}`);
  return new ConvexError(fallback);
}

const missingCustomer = (err: unknown) => err instanceof StripeError && err.code === "resource_missing" && /customer/i.test(err.message);

/** Where Stripe sends the person back to: the app, with what happened. */
function backTo(returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo);
  url.hash = "";
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function newCustomer(ctx: ActionCtx, key: string, me: { userId: string; email?: string; name?: string }, again = false): Promise<string> {
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

/** A plan's product at Stripe, made the first time it's needed. */
async function productOf(key: string, plan: Plan): Promise<string> {
  const id = productId(plan);
  try {
    await call(key, "GET", `/products/${id}`);
    return id;
  } catch (err) {
    if (!(err instanceof StripeError && err.status === 404)) throw err;
  }
  try {
    await call(
      key,
      "POST",
      "/products",
      { id, name: `Holly Bot ${plan.name}`, description: `Runs on a dedicated server with ${plan.cpu} CPU and ${plan.memoryGb} GB RAM.${plan.note ? ` ${plan.note}.` : ""}` },
      { idempotencyKey: `holly-bot-product-${modeOf(key)}-${id}` },
    );
  } catch (err) {
    // Made meanwhile, by another checkout.
    if (!(err instanceof StripeError && err.code === "resource_already_exists")) throw err;
  }
  return id;
}

/** A plan's monthly or yearly price at Stripe, found by its lookup key. A new
 * one is made the first time, and whenever convex/lib/plans.ts changes the
 * amount (it takes over the lookup key; subscribers keep the price they have). */
async function priceOf(key: string, plan: Plan, every: Interval): Promise<string> {
  const lookup = priceKey(plan, every);
  const amount = plan.price[every];
  const found = await call(key, "GET", "/prices", { lookup_keys: [lookup], active: true, limit: 1 });
  const price = found?.data?.[0];
  if (price && price.unit_amount === amount && price.currency === "usd" && price.recurring?.interval === every && (price.recurring?.interval_count ?? 1) === 1) {
    return price.id;
  }
  const made = await call(
    key,
    "POST",
    "/prices",
    {
      product: await productOf(key, plan),
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: every },
      lookup_key: lookup,
      transfer_lookup_key: true,
      nickname: `${plan.name}, ${every === "year" ? "yearly" : "monthly"}`,
    },
    { idempotencyKey: `holly-bot-price-${modeOf(key)}-${lookup}-${amount}` },
  );
  return made.id;
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
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holly Bot can't come back to that address.");
    if (me.open === "active" || me.open === "trialing") throw new ConvexError("This account already has a subscription.");
    if (me.open) throw new ConvexError("Your subscription needs attention first. Update your payment method in billing.");
    const start = async (customer: string): Promise<string> => {
      const session = await call(key, "POST", "/checkout/sessions", {
        mode: "subscription",
        customer,
        client_reference_id: me.userId,
        line_items: [{ price: await priceOf(key, plan, every), quantity: 1 }],
        success_url: backTo(returnTo, { checkout: "done" }),
        cancel_url: backTo(returnTo, { checkout: "cancelled" }),
        metadata: { userId: me.userId, plan: plan.id },
        subscription_data: { metadata: { userId: me.userId, plan: plan.id } },
        custom_text: {
          submit: { message: `Renews automatically every ${every} until you cancel. Cancel anytime in Holly Bot: Settings → Subscription.` },
        },
      });
      if (!session?.url) throw new Error("Stripe didn't return a checkout page");
      return session.url;
    };
    try {
      const customer = me.customerId ?? (await newCustomer(ctx, key, me));
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
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holly Bot can't come back to that address.");
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

/** Asks Stripe for the account's subscriptions and keeps what it says, then
 * says where the account stands: after Checkout or the portal, and when a
 * paid period should have ended. */
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
        if (subs.length) await ctx.runMutation(internal.billing.save, { subs, livemode: modeOf(key) === "live" });
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
 * with STRIPE_WEBHOOK_SECRET. It needs checkout.session.completed and
 * customer.subscription.created, .updated and .deleted. Each event is taken as
 * news that a subscription changed: the subscription itself is read from
 * Stripe again, so events that arrive late or out of order can't undo a newer
 * change. Answering with an error makes Stripe try again later.
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
  const type = String(event?.type ?? "");
  const object = event?.data?.object ?? {};
  let subscriptionId: string | undefined;
  let userHint: string | undefined;
  if (type.startsWith("checkout.session.")) {
    if (object.mode !== "subscription") return reply("ok");
    subscriptionId = idOf(object.subscription);
    userHint = object.client_reference_id || object.metadata?.userId || undefined;
  } else if (type.startsWith("customer.subscription.")) {
    subscriptionId = idOf(object.id);
  } else if (type.startsWith("invoice.")) {
    subscriptionId = idOf(object.subscription ?? object.parent?.subscription_details?.subscription);
  }
  if (!subscriptionId) return reply("ok");
  try {
    const sub = await call(key, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    await ctx.runMutation(internal.billing.save, { subs: [subscriptionState(sub)], livemode: live, userHint });
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return reply("ok"); // gone (test data cleared)
    console.error(`Stripe webhook ${type}: ${err instanceof Error ? err.message : String(err)}`);
    return reply("Try again later", 500);
  }
  return reply("ok");
});

/** Deletes an account's customer at Stripe after the account is deleted
 * (account:deleteAccount), which cancels its subscriptions at once. Tries
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
