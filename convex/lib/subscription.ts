import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// What an account's subscription gives it (convex/billing.ts keeps what
// Stripe says about it in `subscribers`): its paid plan while it's paid up,
// or past due while Stripe tries the card again, and otherwise Free
// (convex/lib/plans.ts FREE). Every signed-in account keeps and uses its data
// either way; the plan decides its AI credits (convex/credits.ts), its files
// (convex/data.ts) and whether it has a server (convex/servers.ts).

/** Stripe statuses that pay for Holli Bot. */
const PAID = new Set(["active", "trialing"]);
/** A renewal that didn't go through: Holli Bot keeps working (and the app
 * asks for a new card) while Stripe tries again. */
const GRACE = "past_due";
/** Statuses a subscription never leaves. */
export const ENDED = new Set(["canceled", "incomplete_expired"]);

/** Stripe starts a new period as the last one ends, and says so. A
 * subscription whose period ended longer ago than this, with no word from
 * Stripe since, no longer counts (the app asks Stripe as soon as the period
 * ends: see needsCheck). */
const LATE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Accounts that get the biggest plan's AI credits without a subscription: the
 * owner's, while they test it. Each is the SHA-256 (hex) of the account's
 * email address in lower case, so the addresses aren't in this public code;
 * make one with `printf %s you@example.com | sha256sum`. These accounts aren't
 * on Free, but get no server.
 */
const EXEMPT = new Set<string>([
  // "434633ce2df27abbb930fa08014a267046ef87c349456af49eefacaa07b51600", // the owner: off while they test subscribing
]);

type State = Pick<Doc<"subscribers">, "livemode" | "subscriptionStatus" | "currentPeriodEnd" | "cancelAt">;

/** Whether Stripe runs in live mode (a live key is set) or test mode, or
 * undefined with no key. A subscription only counts in its own mode, so a test
 * subscription never opens Holli Bot once real payments are switched on. */
export function liveMode(): boolean | undefined {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? /_live_/.test(key) : undefined;
}

function current(sub: State): boolean {
  const live = liveMode();
  return live === undefined || sub.livemode === live;
}

/** Paid up: active, or trialing. */
export function isPaid(sub: State | null, now = Date.now()): boolean {
  return !!sub && PAID.has(sub.subscriptionStatus ?? "") && inTime(sub, now);
}

/** Paid up, or a renewal Stripe is still trying to collect (past_due). */
export function hasAccess(sub: State | null, now = Date.now()): boolean {
  return !!sub && (PAID.has(sub.subscriptionStatus ?? "") || sub.subscriptionStatus === GRACE) && inTime(sub, now);
}

function inTime(sub: State, now: number): boolean {
  if (!current(sub)) return false;
  if (sub.cancelAt !== undefined && sub.cancelAt <= now) return false;
  return sub.currentPeriodEnd === undefined || sub.currentPeriodEnd + LATE_MS > now;
}

/** A subscription whose period (or the subscription) should have ended by now
 * while it still counts: Stripe hasn't said what happened, so it's worth asking. */
export function needsCheck(sub: State | null, now = Date.now()): boolean {
  if (!sub || !current(sub) || !(PAID.has(sub.subscriptionStatus ?? "") || sub.subscriptionStatus === GRACE)) return false;
  return (sub.currentPeriodEnd !== undefined && sub.currentPeriodEnd <= now) || (sub.cancelAt !== undefined && sub.cancelAt <= now);
}

/** The account's row in `subscribers`, if it has started subscribing. */
export function subscriberOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"subscribers"> | null> {
  return ctx.db.query("subscribers").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether the account uses Holli Bot without a subscription (EXEMPT), by
 * its email address as Google or Apple verified it. */
export async function isExempt(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  const email = user?.email?.trim().toLowerCase();
  return !!email && user?.emailVerificationTime !== undefined && EXEMPT.has(await sha256(email));
}

/** Whether the account is on Free: no paid plan that lets it in, and not exempt. */
export async function isFree(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<boolean> {
  return !hasAccess(await subscriberOf(ctx, userId)) && !(await isExempt(ctx, userId));
}
