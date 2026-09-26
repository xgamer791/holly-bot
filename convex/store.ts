import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isAllowedRedirect } from "./auth";
import { asError, backTo, missingCustomer, newCustomer, secretKey } from "./billing";
import { requireUserId } from "./lib/auth";
import { CATEGORIES, LIMITS, byOrder, cleanBot, isSample, isStoreAdmin, publicView, storeSession, type StoreBot } from "./lib/store";
import { SAMPLE_BOTS } from "./lib/storeSamples";
import { call } from "./lib/stripe";
import { liveMode } from "./lib/subscription";

// The Bot Store (convex/lib/store.ts has what it's made of). People open it in
// the app (Settings → Bot Store, src/ui/store.js), tap a bot's price, then
// Buy, and pay once on Stripe Checkout (mode=payment, cards and Apple Pay or
// Google Pay). Back in the app, `claim` asks Stripe whether it's paid and
// keeps the purchase; Stripe's webhook keeps it too (convex/billing.ts), in
// case the person never comes back. The app then makes the bot (`install`:
// its look and its rules, never its memory), and can again whenever it's gone.
// Its memory stays here, for Holli Bot's AI (`memoryFor`, convex/ai.ts).
//
// The owner (lib/store.ts isStoreAdmin) adds, changes and hides bots in the
// app (`manage`, `save`). Prices come from here, never from the app.

const publicBot = v.object({
  id: v.string(),
  name: v.string(),
  tagline: v.string(),
  about: v.string(),
  category: v.string(),
  shape: v.string(),
  color: v.string(),
  thinking: v.optional(v.string()),
  price: v.number(),
  highlights: v.array(v.string()),
  featured: v.boolean(),
  sample: v.boolean(),
});

const botInput = v.object({
  name: v.string(),
  tagline: v.string(),
  about: v.string(),
  category: v.string(),
  shape: v.string(),
  color: v.string(),
  thinking: v.optional(v.string()),
  price: v.number(),
  highlights: v.array(v.string()),
  memory: v.string(),
  rules: v.string(),
  featured: v.boolean(),
  listed: v.boolean(),
});

const purchaseInfo = v.object({
  sessionId: v.string(),
  userId: v.string(),
  bot: v.string(),
  amount: v.number(),
  currency: v.string(),
  livemode: v.boolean(),
  paymentIntent: v.optional(v.string()),
  paid: v.boolean(),
});

/** A row as the store's bot. */
function fromRow(row: Doc<"storeBots">): StoreBot {
  const { slug, name, tagline, about, category, shape, color, thinking, price, highlights, memory, rules, featured, listed, order } = row;
  return { slug, name, tagline, about, category, shape, color, ...(thinking ? { thinking } : {}), price, highlights, memory, rules, featured, listed, order };
}

/** What's on sale, in the store's order: the owner's listed bots, or the
 * samples until the owner lists one. */
async function onSale(ctx: QueryCtx): Promise<StoreBot[]> {
  const rows = await ctx.db.query("storeBots").withIndex("by_listed", (q) => q.eq("listed", true)).collect();
  const bots = rows.length ? rows.map(fromRow) : SAMPLE_BOTS.filter((bot) => bot.listed);
  return bots.sort(byOrder);
}

/** A bot by its slug, on sale or not: the owner's, or a sample. */
async function botOf(ctx: QueryCtx, slug: string): Promise<StoreBot | null> {
  const row = await ctx.db.query("storeBots").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (row) return fromRow(row);
  return SAMPLE_BOTS.find((bot) => bot.slug === slug) ?? null;
}

/** The slugs of the bots an account bought, in the current Stripe mode. */
async function boughtBy(ctx: QueryCtx, userId: Id<"users">): Promise<Set<string>> {
  const live = liveMode();
  const rows = await ctx.db.query("storePurchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  return new Set(rows.filter((row) => live === undefined || row.livemode === live).map((row) => row.bot));
}

async function owns(ctx: QueryCtx, userId: Id<"users">, slug: string): Promise<boolean> {
  const live = liveMode();
  const rows = await ctx.db.query("storePurchases").withIndex("by_user_bot", (q) => q.eq("userId", userId).eq("bot", slug)).collect();
  return rows.some((row) => live === undefined || row.livemode === live);
}

async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  if (!(await isStoreAdmin(ctx, userId))) throw new ConvexError("Only the Bot Store's owner can do that.");
  return userId;
}

/**
 * The store, for the signed-in account: the bots on sale, which of them it
 * bought (`owned`), whether it's the owner's (`admin`), whether the samples
 * are standing in (`samples`), and whether paying works yet (`ready`).
 */
export const catalog = query({
  args: {},
  returns: v.object({
    ready: v.boolean(),
    admin: v.boolean(),
    samples: v.boolean(),
    categories: v.array(v.string()),
    bots: v.array(publicBot),
    owned: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const bots = await onSale(ctx);
    return {
      ready: !!secretKey(),
      admin: await isStoreAdmin(ctx, userId),
      samples: bots.some((bot) => isSample(bot.slug)),
      categories: CATEGORIES,
      bots: bots.map(publicView),
      owned: [...(await boughtBy(ctx, userId))],
    };
  },
});

/** A bot as `checkout` sells it: on sale, with what it costs, and whether
 * the account already has it. null when it isn't on sale. */
export const offer = internalQuery({
  args: { userId: v.id("users"), bot: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string(), tagline: v.string(), price: v.number(), owned: v.boolean() })),
  handler: async (ctx, { userId, bot: slug }) => {
    if (await owns(ctx, userId, slug)) {
      const bot = await botOf(ctx, slug);
      return bot ? { name: bot.name, tagline: bot.tagline, price: bot.price, owned: true } : null;
    }
    const bot = (await onSale(ctx)).find((b) => b.slug === slug);
    if (!bot || bot.price < LIMITS.minPrice) return null;
    return { name: bot.name, tagline: bot.tagline, price: bot.price, owned: false };
  },
});

/**
 * Buying a bot: the address of Stripe Checkout for it, a one-time payment at
 * the store's price, with the account's Stripe customer (so its saved card
 * shows). Stripe sends the person back to `returnTo` with ?store=done&bot=…
 * &session=… (claim), or ?store=cancelled&bot=…. A bot the account already
 * bought isn't sold again: `owned` says to add it instead.
 */
export const checkout = action({
  args: { bot: v.string(), returnTo: v.string() },
  returns: v.object({ url: v.optional(v.string()), owned: v.optional(v.boolean()) }),
  handler: async (ctx, { bot: slug, returnTo }): Promise<{ url?: string; owned?: boolean }> => {
    const me = await ctx.runQuery(internal.billing.mine, {});
    const key = secretKey();
    if (!key) throw new ConvexError("The Bot Store isn't set up on Holli Bot's server yet.");
    const offer = await ctx.runQuery(internal.store.offer, { userId: me.userId, bot: slug });
    if (!offer) throw new ConvexError("That bot isn't in the Bot Store any more.");
    if (offer.owned) return { owned: true };
    if (!isAllowedRedirect(returnTo, process.env.SITE_URL)) throw new ConvexError("Holli Bot can't come back to that address.");
    const metadata = { kind: "store", userId: me.userId, bot: slug };
    const start = async (customer: string): Promise<string> => {
      const session = await call(key, "POST", "/checkout/sessions", {
        mode: "payment",
        customer,
        client_reference_id: me.userId,
        line_items: [{
          quantity: 1,
          price_data: { currency: "usd", unit_amount: offer.price, product_data: { name: offer.name, description: offer.tagline || undefined } },
        }],
        // Cards, with Apple Pay and Google Pay where the device has them: paid
        // the moment the session completes.
        payment_method_types: ["card"],
        submit_type: "pay",
        // Stripe puts the session's id in place of {CHECKOUT_SESSION_ID}, which
        // has to reach it as it is, braces and all.
        success_url: `${backTo(returnTo, { store: "done", bot: slug })}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: backTo(returnTo, { store: "cancelled", bot: slug }),
        metadata,
        payment_intent_data: { description: `Holli Bot Store: ${offer.name}`, metadata },
        custom_text: { submit: { message: "A one-time purchase. Your new bot joins your bots as soon as you've paid." } },
      });
      if (!session?.url) throw new Error("Stripe didn't return a checkout page");
      return session.url;
    };
    try {
      const customer = me.customerId ?? (await newCustomer(ctx, key, me));
      try {
        return { url: await start(customer) };
      } catch (err) {
        if (!missingCustomer(err)) throw err;
        await ctx.runMutation(internal.billing.dropCustomer, { customerId: customer });
        return { url: await start(await newCustomer(ctx, key, me, true)) };
      }
    } catch (err) {
      throw asError(err, "Couldn't start checkout. Try again in a minute.");
    }
  },
});

/**
 * Back from Stripe Checkout with ?session=…: asks Stripe whether that
 * purchase is this account's and paid, keeps it, and says which bot it was.
 */
export const claim = action({
  args: { session: v.string() },
  returns: v.object({ bot: v.string() }),
  handler: async (ctx, { session }): Promise<{ bot: string }> => {
    const me = await ctx.runQuery(internal.billing.mine, {});
    const key = secretKey();
    if (!key) throw new ConvexError("The Bot Store isn't set up on Holli Bot's server yet.");
    if (!/^cs_\w{8,250}$/.test(session)) throw new ConvexError("That purchase can't be found.");
    let bought: ReturnType<typeof storeSession>;
    try {
      bought = storeSession(await call(key, "GET", `/checkout/sessions/${encodeURIComponent(session)}`));
    } catch (err) {
      throw asError(err, "Couldn't check that purchase with Stripe. Try again in a minute.");
    }
    if (!bought || bought.userId !== me.userId) throw new ConvexError("That purchase isn't this account's.");
    if (!bought.paid) throw new ConvexError("That payment hasn't gone through yet. Try again in a minute.");
    await ctx.runMutation(internal.store.record, { purchase: bought });
    return { bot: bought.bot };
  },
});

/**
 * Keeps a paid purchase, once per Checkout session (`claim` and the webhook
 * may both bring it). With `event` (the webhook), the event is handled once.
 */
export const record = internalMutation({
  args: { purchase: purchaseInfo, event: v.optional(v.object({ id: v.string(), type: v.string() })) },
  returns: v.string(),
  handler: async (ctx, { purchase, event }) => {
    if (event) {
      if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", event.id)).first()) return "repeat";
      await ctx.db.insert("stripeEvents", { eventId: event.id, type: event.type, processedAt: Date.now() });
    }
    if (!purchase.paid) return "not paid";
    const userId = ctx.db.normalizeId("users", purchase.userId);
    if (!userId || !(await ctx.db.get(userId))) return "not ours"; // an account deleted since
    if (await ctx.db.query("storePurchases").withIndex("by_session", (q) => q.eq("sessionId", purchase.sessionId)).first()) return "known";
    const bot = await botOf(ctx, purchase.bot);
    await ctx.db.insert("storePurchases", {
      userId,
      bot: purchase.bot,
      name: bot?.name ?? purchase.bot,
      amount: purchase.amount,
      currency: purchase.currency,
      livemode: purchase.livemode,
      sessionId: purchase.sessionId,
      ...(purchase.paymentIntent ? { paymentIntent: purchase.paymentIntent } : {}),
      paidAt: Date.now(),
    });
    return "ok";
  },
});

/**
 * What the app makes a bought bot from: its name, look, tagline and the
 * rules it comes with. Never its memory, which stays here (memoryFor). For
 * the accounts that bought it, and the owner's.
 */
export const install = query({
  args: { bot: v.string() },
  returns: v.object({
    id: v.string(),
    name: v.string(),
    tagline: v.string(),
    shape: v.string(),
    color: v.string(),
    thinking: v.optional(v.string()),
    rules: v.string(),
  }),
  handler: async (ctx, { bot: slug }) => {
    const userId = await requireUserId(ctx);
    const bot = await botOf(ctx, slug);
    if (!bot) throw new ConvexError("That bot isn't in the Bot Store any more.");
    if (!(await owns(ctx, userId, slug)) && !(await isStoreAdmin(ctx, userId))) throw new ConvexError("Buy this bot first.");
    return {
      id: bot.slug,
      name: bot.name,
      tagline: bot.tagline,
      shape: bot.shape,
      color: bot.color,
      ...(bot.thinking ? { thinking: bot.thinking } : {}),
      rules: bot.rules,
    };
  },
});

/**
 * A bought bot's memory, for Holli Bot's AI to add to its requests
 * (convex/ai.ts): only for an account that bought it, or the owner's. It
 * still works for its buyers after it's hidden from the store.
 */
export const memoryFor = internalQuery({
  args: { userId: v.id("users"), bot: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { userId, bot: slug }) => {
    const bot = await botOf(ctx, slug);
    if (!bot?.memory.trim()) return null;
    if (!(await owns(ctx, userId, slug)) && !(await isStoreAdmin(ctx, userId))) return null;
    return bot.memory;
  },
});

const adminBot = v.object({
  id: v.string(),
  name: v.string(),
  tagline: v.string(),
  about: v.string(),
  category: v.string(),
  shape: v.string(),
  color: v.string(),
  thinking: v.optional(v.string()),
  price: v.number(),
  highlights: v.array(v.string()),
  memory: v.string(),
  rules: v.string(),
  featured: v.boolean(),
  listed: v.boolean(),
  sold: v.number(),
});

/** The owner's bots, listed or hidden, all of each (its memory too), with
 * how many times each has sold. The samples aren't among them. */
export const manage = query({
  args: {},
  returns: v.object({ bots: v.array(adminBot), categories: v.array(v.string()) }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const live = liveMode();
    const rows = (await ctx.db.query("storeBots").collect()).map(fromRow).sort(byOrder);
    const bots = [];
    for (const bot of rows) {
      const sales = await ctx.db.query("storePurchases").withIndex("by_bot", (q) => q.eq("bot", bot.slug)).collect();
      const { slug, order, ...rest } = bot;
      bots.push({ id: slug, ...rest, sold: sales.filter((sale) => live === undefined || sale.livemode === live).length });
    }
    return { bots, categories: CATEGORIES };
  },
});

/**
 * Adds a bot to the store, or changes one (`id`): all of it, checked
 * (lib/store.ts cleanBot). A new one goes at the end of the store. Its id.
 */
export const save = mutation({
  args: { id: v.optional(v.string()), bot: botInput },
  returns: v.string(),
  handler: async (ctx, { id, bot }) => {
    await requireAdmin(ctx);
    const clean = cleanBot(bot);
    const now = Date.now();
    if (id) {
      const row = await ctx.db.query("storeBots").withIndex("by_slug", (q) => q.eq("slug", id)).unique();
      if (!row) throw new ConvexError("That bot isn't in the Bot Store any more.");
      await ctx.db.replace(row._id, { ...clean, slug: row.slug, order: row.order, createdAt: row.createdAt, updatedAt: now });
      return row.slug;
    }
    let slug = "";
    do {
      slug = `sb_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    } while (await ctx.db.query("storeBots").withIndex("by_slug", (q) => q.eq("slug", slug)).first());
    await ctx.db.insert("storeBots", { ...clean, slug, order: now, createdAt: now, updatedAt: now });
    return slug;
  },
});
