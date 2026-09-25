import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { PLANS, planById } from "./lib/plans";
import { INACTIVE, hasAccess, isExempt, subscriberOf } from "./lib/subscription";
import { MICROS_PER_CENT, anchorFor, costOf, estimateUsage, refillIn, settle, type Ledger } from "./lib/credits";

// AI credits. Holly Bot's AI is DeepSeek's models on Holly Bot's own account,
// through OpenRouter or DeepSeek's own API (convex/ai.ts), and each account
// gets its plan's allowance of it every month (convex/lib/plans.ts): Starter
// $10, Pro $20, Ultra $35 of use, which the app shows as credits, 1 per cent.
// Every request is let in only while credits are left (`admit`, which holds
// back what it could cost at most, so requests at once can't spend more than
// is left), and then charged what it cost (`charge`, which gives back the rest
// of the hold): what OpenRouter says it came to, or what DeepSeek says it
// used at DeepSeek's prices.
// A new month refills the credits; unused ones don't carry over. The months
// start on the day the account's paid period renews, so a monthly plan's
// credits refill as it's billed, and a yearly plan's refill monthly on that
// day. When they run out, bots pause until the refill.

const usage = v.object({ cached: v.number(), fresh: v.number(), output: v.number(), cost: v.optional(v.number()) });

/** The account's plan allowance (millionths of a dollar a month) and the end
 * of its paid period; the biggest plan's for an exempt account; null without
 * a subscription that lets it in. */
async function planOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<{ allowance: number; periodEnd?: number } | null> {
  const sub = await subscriberOf(ctx, userId);
  if (sub && hasAccess(sub)) {
    return { allowance: (planById(sub.plan)?.credits ?? PLANS[0].credits) * MICROS_PER_CENT, periodEnd: sub.currentPeriodEnd };
  }
  if (await isExempt(ctx, userId)) return { allowance: Math.max(...PLANS.map((plan) => plan.credits)) * MICROS_PER_CENT };
  return null;
}

function rowOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"credits"> | null> {
  return ctx.db.query("credits").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

function ledgerOf(row: Doc<"credits"> | null): Ledger | null {
  if (!row) return null;
  const { _id, _creationTime, userId, updatedAt, ...ledger } = row;
  return ledger;
}

/** Keeps `ledger` as the account's credits. */
async function save(ctx: MutationCtx, userId: Id<"users">, row: Doc<"credits"> | null, ledger: Ledger) {
  if (row) await ctx.db.patch(row._id, { ...ledger, updatedAt: Date.now() });
  else await ctx.db.insert("credits", { userId, ...ledger, updatedAt: Date.now() });
}

/** The signed-in account's credits this month, for the app's bar: what the
 * month gives and what's left (millionths of a dollar; the app shows credits),
 * and when they refill. `ready`: Holly Bot's server can run its AI (its
 * OpenRouter or DeepSeek key is set). Null without a subscription that lets it in. */
export const mine = query({
  args: {},
  returns: v.union(v.null(), v.object({ ready: v.boolean(), allowance: v.number(), balance: v.number(), refillsAt: v.number() })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const plan = await planOf(ctx, userId);
    if (!plan) return null;
    const now = Date.now();
    const ledger = settle(ledgerOf(await rowOf(ctx, userId)), plan.allowance, anchorFor(plan.periodEnd, now), now);
    const ready = !!(process.env.OPENROUTER_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim());
    return { ready, allowance: ledger.allowance, balance: Math.max(0, ledger.balance), refillsAt: ledger.periodEnd };
  },
});

/**
 * Lets a request to Holly Bot's AI through (convex/ai.ts) for an account
 * signed in with a session that's still open, whose subscription lets it in,
 * and that has credits left. It holds back `hold`, what the request could
 * cost at most, or whatever is left when that's less; `charge` settles it.
 */
export const admit = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions"), hold: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true), held: v.number() }),
    v.object({ ok: v.literal(false), status: v.number(), code: v.string(), message: v.string() }),
  ),
  handler: async (ctx, { userId, sessionId, hold }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== userId) {
      return { ok: false as const, status: 401, code: "not_signed_in", message: "Sign in to Holly Bot again to keep using its AI." };
    }
    const plan = await planOf(ctx, userId);
    if (!plan) return { ok: false as const, status: 402, code: "not_subscribed", message: INACTIVE };
    const now = Date.now();
    const row = await rowOf(ctx, userId);
    const before = ledgerOf(row);
    const ledger = settle(before, plan.allowance, anchorFor(plan.periodEnd, now), now);
    if (ledger.balance <= 0) {
      if (ledger !== before) await save(ctx, userId, row, ledger);
      return { ok: false as const, status: 402, code: "no_credits", message: `Your AI credits for this month are used up. Your bots pause until they refill, ${refillIn(ledger.periodEnd, now)}.` };
    }
    const held = Math.max(0, Math.min(Math.ceil(hold), ledger.balance));
    await save(ctx, userId, row, { ...ledger, balance: ledger.balance - held });
    return { ok: true as const, held };
  },
});

/**
 * Charges a finished request (convex/ai.ts): what OpenRouter said it cost, or
 * what DeepSeek said it used at DeepSeek's prices, or, when the answer was cut
 * off before either said, an estimate from the request's input and what was
 * sent back, at the list prices of where it ran (`via`). The hold `admit`
 * took is given back first.
 */
export const charge = internalMutation({
  args: {
    userId: v.id("users"),
    model: v.string(),
    at: v.number(),
    held: v.number(),
    via: v.optional(v.union(v.literal("openrouter"), v.literal("deepseek"))),
    usage: v.optional(usage),
    estimate: v.optional(v.object({ prompt: v.number(), output: v.number() })),
  },
  returns: v.number(),
  handler: async (ctx, { userId, model, at, held, via, usage, estimate }) => {
    const now = Date.now();
    const row = await rowOf(ctx, userId);
    const plan = await planOf(ctx, userId);
    // A subscription that ended meanwhile still pays for what it already asked for.
    const allowance = plan?.allowance ?? row?.allowance ?? 0;
    const ledger = settle(ledgerOf(row), allowance, anchorFor(plan?.periodEnd, now), now);
    // A hold from last month isn't given back into a month that just refilled.
    const back = ledgerOf(row) && ledger.periodStart !== row!.periodStart ? 0 : held;
    const used = usage ?? estimateUsage(estimate?.prompt ?? 0, estimate?.output ?? 0, ledger);
    const cost = costOf(model, used, at, via ?? "deepseek");
    await save(ctx, userId, row, {
      ...ledger,
      balance: ledger.balance + back - cost,
      spent: ledger.spent + cost,
      requests: ledger.requests + 1,
      cachedTokens: ledger.cachedTokens + used.cached,
      freshTokens: ledger.freshTokens + used.fresh,
      outputTokens: ledger.outputTokens + used.output,
    });
    return cost;
  },
});
