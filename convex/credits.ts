import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { FREE, PLANS, planById } from "./lib/plans";
import { hasAccess, isExempt, subscriberOf } from "./lib/subscription";
import { MICROS_PER_CENT, anchorFor, costOf, dayKey, estimateUsage, refillHours, refillIn, settle, type Ledger } from "./lib/credits";

// AI credits. Holli Bot's AI is DeepSeek on Holli Bot's own key
// (convex/ai.ts), and each account gets its plan's allowance of it every month
// (convex/lib/plans.ts): Starter $10, Pro $20, Ultra $35 of DeepSeek use,
// which the app shows as credits, 1 per cent. An account without a paid plan
// is on Free: 10 credits a day, from midnight UTC, on Flash only. Every
// request is let in only while credits are left (`admit`, which holds back
// what it could cost at most, so requests at once can't spend more than is
// left), and then charged what DeepSeek says it used (`charge`, which lets
// the hold go). Holds are kept apart from the credits (`creditHolds`), so
// what's left, as the app shows it, only goes down by what requests cost,
// never by a hold for a moment. Credits are charged at what DeepSeek bills,
// which is double in its peak hours, so they go twice as far outside them.
// A new month (on Free, a new day) refills the credits; unused ones don't
// carry over. The months start on the day the account's paid period renews,
// so a monthly plan's credits refill as it's billed, and a yearly plan's
// refill monthly on that day. When they run out, bots pause until the refill.
//
// Free has limits of its own, checked here as each request comes in: Flash
// only, at most FREE.maxTokens of output and FREE.maxPrompt of input a
// request, and all Free accounts together at most the day's budget
// (FREE_DAILY_BUDGET_USD, kept in `freeSpend`).

const usage = v.object({ cached: v.number(), fresh: v.number(), output: v.number() });

/** Where an account's credits come from: its paid plan's allowance a month,
 * from the day its paid period renews (`periodEnd`); the biggest plan's for
 * an exempt account; or else Free's a day. In millionths of a dollar. */
interface Source {
  kind: "paid" | "exempt" | "free";
  allowance: number;
  periodEnd?: number;
}

async function planOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Source> {
  const sub = await subscriberOf(ctx, userId);
  if (sub && hasAccess(sub)) {
    return { kind: "paid", allowance: (planById(sub.plan)?.credits ?? PLANS[0].credits) * MICROS_PER_CENT, periodEnd: sub.currentPeriodEnd };
  }
  if (await isExempt(ctx, userId)) return { kind: "exempt", allowance: Math.max(...PLANS.map((plan) => plan.credits)) * MICROS_PER_CENT };
  return { kind: "free", allowance: FREE.credits * MICROS_PER_CENT };
}

/** The account's credits as they stand at `now` (settle: `before` itself when nothing changed). */
function settled(before: Ledger | null, plan: Source, now: number): Ledger {
  return settle(before, plan.allowance, anchorFor(plan.periodEnd, now), now, plan.kind === "free");
}

function rowOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"credits"> | null> {
  return ctx.db.query("credits").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

function ledgerOf(row: Doc<"credits"> | null): Ledger | null {
  if (!row) return null;
  const { _id, _creationTime, userId, updatedAt, ...ledger } = row;
  return ledger;
}

/** Keeps `ledger` as the account's credits (`daily` goes when it's off). */
async function save(ctx: MutationCtx, userId: Id<"users">, row: Doc<"credits"> | null, ledger: Ledger) {
  if (row) await ctx.db.patch(row._id, { ...ledger, daily: ledger.daily || undefined, updatedAt: Date.now() });
  else await ctx.db.insert("credits", { userId, ...ledger, updatedAt: Date.now() });
}

/** How long a hold lasts: far longer than a request to Holli Bot's AI can run. */
const HOLD_MS = 60 * 60_000;

/** The credits' period a hold is taken in: the month, or Free's day. */
const periodKey = (ledger: Ledger) => `${ledger.daily ? "day" : "month"}:${ledger.periodStart}`;

function holdsOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"creditHolds">[]> {
  return ctx.db.query("creditHolds").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
}

/**
 * `ledger` with the account's `holds` as they stand at `now`. A hold whose
 * request never came back to be charged (cut off with no word) has expired:
 * it's charged in full, the most that request could have cost, since what it
 * used is unknown; one from before the credits refilled is only let go.
 * `holding`: what the others hold back. `expired`: the holds to let go.
 */
function withHolds(ledger: Ledger, holds: Doc<"creditHolds">[], now: number) {
  let next = ledger;
  let holding = 0;
  const expired: Doc<"creditHolds">[] = [];
  for (const hold of holds) {
    if (hold.expiresAt > now) {
      holding += hold.amount;
      continue;
    }
    expired.push(hold);
    if (hold.period === periodKey(ledger)) {
      next = { ...next, balance: next.balance - hold.amount, spent: next.spent + hold.amount, requests: next.requests + 1 };
    }
  }
  return { ledger: next, holding, expired };
}

/** withHolds, letting the expired holds go. */
async function settleHolds(ctx: MutationCtx, userId: Id<"users">, ledger: Ledger, now: number) {
  const result = withHolds(ledger, await holdsOf(ctx, userId), now);
  for (const hold of result.expired) await ctx.db.delete(hold._id);
  return result;
}

/** What all Free accounts together may spend a day, in millionths of a
 * dollar: FREE_DAILY_BUDGET_USD (in US dollars; 0 turns Free's AI off), or
 * FREE.dailyBudget when it isn't set. */
function freeBudget(): number {
  const set = process.env.FREE_DAILY_BUDGET_USD?.trim();
  const dollars = set && Number.isFinite(Number(set)) && Number(set) >= 0 ? Number(set) : FREE.dailyBudget;
  return Math.round(dollars * 1_000_000);
}

function spendOf(ctx: QueryCtx | MutationCtx, day: string): Promise<Doc<"freeSpend"> | null> {
  return ctx.db.query("freeSpend").withIndex("by_day", (q) => q.eq("day", day)).unique();
}

/** Adds `micros` (and `requests`) to what Free spent on `day`. */
async function addSpend(ctx: MutationCtx, day: string, micros: number, requests: number) {
  const row = await spendOf(ctx, day);
  const now = Date.now();
  if (row) await ctx.db.patch(row._id, { used: Math.max(0, row.used + micros), requests: row.requests + requests, updatedAt: now });
  else await ctx.db.insert("freeSpend", { day, used: Math.max(0, micros), requests, updatedAt: now });
}

/** The signed-in account's credits, for the app's bar: what the month (on
 * Free, the day) gives and what's left (millionths of a dollar; the app shows
 * credits), and when they refill. What's left is what requests have cost,
 * not what's held for those under way. `plan`: "free", "paid" or "exempt".
 * `ready`: Holli Bot's server can run its AI (its DeepSeek key is set).
 * `minute`: the minute the app asks in. Convex keeps a query's answer until
 * what it read changes, and time passing isn't that: a new minute is a new
 * question, so a refill at midnight shows as it happens. */
export const mine = query({
  args: { minute: v.optional(v.number()) },
  returns: v.object({ ready: v.boolean(), allowance: v.number(), balance: v.number(), refillsAt: v.number(), plan: v.string() }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const plan = await planOf(ctx, userId);
    const now = Date.now();
    const { ledger } = withHolds(settled(ledgerOf(await rowOf(ctx, userId)), plan, now), await holdsOf(ctx, userId), now);
    return {
      ready: !!process.env.DEEPSEEK_API_KEY?.trim(),
      allowance: ledger.allowance,
      balance: Math.max(0, ledger.balance),
      refillsAt: ledger.periodEnd,
      plan: plan.kind,
    };
  },
});

const refusal = (status: number, code: string, message: string) => ({ ok: false as const, status, code, message });

/**
 * Lets a request to Holli Bot's AI through (convex/ai.ts) for an account
 * signed in with a session that's still open, that has credits left, and, on
 * Free, within Free's limits. It holds back what the request could cost at
 * most (all `prompt` new to DeepSeek, and all the output it may ask for), or
 * whatever isn't held for other requests already when that's less, as its
 * own row in `creditHolds` (`holdId`); `charge` settles it. `maxTokens`: the
 * output it asks for, which comes back capped on Free. `freeDay`: a Free
 * request's day in `freeSpend`, for `charge`.
 */
export const admit = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions"), model: v.string(), prompt: v.number(), maxTokens: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true), held: v.number(), holdId: v.id("creditHolds"), maxTokens: v.number(), freeDay: v.optional(v.string()) }),
    v.object({ ok: v.literal(false), status: v.number(), code: v.string(), message: v.string() }),
  ),
  handler: async (ctx, { userId, sessionId, model, prompt, maxTokens }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== userId) return refusal(401, "not_signed_in", "Sign in to Holli Bot again to keep using its AI.");
    const plan = await planOf(ctx, userId);
    const free = plan.kind === "free";
    if (free) {
      if (model !== FREE.model) return refusal(403, "free_model", "DeepSeek V4 Pro comes with a paid plan. On Free, your bots think with DeepSeek V4.1 Flash.");
      if (prompt > FREE.maxPrompt) return refusal(413, "free_too_long", "This chat is too long for Free. Start a new chat, or upgrade to keep going.");
      maxTokens = Math.min(maxTokens, FREE.maxTokens);
    }
    const now = Date.now();
    const row = await rowOf(ctx, userId);
    const before = ledgerOf(row);
    const { ledger, holding } = await settleHolds(ctx, userId, settled(before, plan, now), now);
    if (ledger !== before) await save(ctx, userId, row, ledger);
    if (ledger.balance <= 0) {
      return free
        ? refusal(402, "free_credits", `Today's free AI credits are used up. Your bots pause until they refill at midnight UTC, ${refillHours(ledger.periodEnd, now)}, or upgrade for more.`)
        : refusal(402, "no_credits", `Your AI credits for this month are used up. Your bots pause until they refill, ${refillIn(ledger.periodEnd, now)}.`);
    }
    // Some left, but all of it held for requests under way, which may not
    // need it: it's free again as they finish.
    const available = ledger.balance - holding;
    if (available <= 0) {
      return refusal(429, "credits_busy", "Your bots are using the rest of your AI credits right now. Try again when they finish.");
    }
    const day = free ? dayKey(now) : undefined;
    if (day && ((await spendOf(ctx, day))?.used ?? 0) >= freeBudget()) {
      return refusal(503, "free_capacity", "Free is at capacity today. It opens again at midnight UTC, or upgrade to keep going now.");
    }
    const most = costOf(model, { cached: 0, fresh: prompt, output: maxTokens }, now);
    const held = Math.max(1, Math.min(Math.ceil(most), available));
    const holdId = await ctx.db.insert("creditHolds", { userId, amount: held, period: periodKey(ledger), expiresAt: now + HOLD_MS });
    if (day) await addSpend(ctx, day, held, 1);
    return { ok: true as const, held, holdId, maxTokens, ...(day ? { freeDay: day } : {}) };
  },
});

/**
 * Charges a finished request (convex/ai.ts): what DeepSeek said it used, or,
 * when the answer was cut off before it said, an estimate from the request's
 * input and what was sent back. The hold `admit` took (`holdId`) goes, and a
 * Free request's day in `freeSpend` gets its cost in place of its hold. A
 * hold that's gone already outlived its hour and was charged in full.
 */
export const charge = internalMutation({
  args: {
    userId: v.id("users"),
    model: v.string(),
    at: v.number(),
    held: v.number(),
    holdId: v.optional(v.id("creditHolds")),
    usage: v.optional(usage),
    estimate: v.optional(v.object({ prompt: v.number(), output: v.number() })),
    freeDay: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, { userId, model, at, held, holdId, usage, estimate, freeDay }) => {
    if (holdId) {
      const hold = await ctx.db.get(holdId);
      if (!hold || hold.userId !== userId) return 0;
      await ctx.db.delete(holdId);
    }
    const now = Date.now();
    const row = await rowOf(ctx, userId);
    const before = ledgerOf(row);
    // A plan that ended (or started) meanwhile: the request is charged to the
    // credits the account has now.
    const { ledger } = await settleHolds(ctx, userId, settled(before, await planOf(ctx, userId), now), now);
    // A request let in before holds were kept apart took its hold out of the
    // credits: it's given back, unless they've refilled since.
    const back = !holdId && before && ledger.periodStart === before.periodStart && !!ledger.daily === !!before.daily ? held : 0;
    const used = usage ?? estimateUsage(estimate?.prompt ?? 0, estimate?.output ?? 0, ledger);
    const cost = costOf(model, used, at);
    await save(ctx, userId, row, {
      ...ledger,
      balance: ledger.balance + back - cost,
      spent: ledger.spent + cost,
      requests: ledger.requests + 1,
      cachedTokens: ledger.cachedTokens + used.cached,
      freshTokens: ledger.freshTokens + used.fresh,
      outputTokens: ledger.outputTokens + used.output,
    });
    if (freeDay) await addSpend(ctx, freeDay, cost - held, 0);
    return cost;
  },
});

/** Holds whose request never came back to be charged (withHolds), for
 * accounts that haven't asked Holli Bot's AI anything since: charged in full,
 * so their credits show it. Every hour (convex/crons.ts). */
export const sweepHolds = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db.query("creditHolds").withIndex("by_expiry", (q) => q.lte("expiresAt", now)).take(200);
    for (const userId of new Set(expired.map((hold) => hold.userId))) {
      const row = await rowOf(ctx, userId);
      const before = ledgerOf(row);
      const { ledger } = await settleHolds(ctx, userId, settled(before, await planOf(ctx, userId), now), now);
      if (ledger !== before) await save(ctx, userId, row, ledger);
    }
    return null;
  },
});
