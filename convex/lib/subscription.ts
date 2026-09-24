import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireUserId } from "./auth";

// Whether an account's subscription lets it use Holly Bot (convex/billing.ts
// keeps what Stripe says about it in `subscribers`). Holly Bot's server keeps
// and uses an account's data only while it does, or while the account is
// exempt: see requireSubscriber.

/** What the server says to an account without a subscription. The app and
 * Holly Computer know it by "active subscription" (src/account/cloud-db.js):
 * nothing is lost, and changes wait on the device until it's active again. */
export const INACTIVE = "Holly Bot needs an active subscription. Choose a plan in the app to keep going.";

/** Stripe statuses that pay for Holly Bot. */
const PAID = new Set(["active", "trialing"]);
/** A renewal that didn't go through: Holly Bot keeps working (and the app
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
 * Accounts that use Holly Bot without a subscription: the owner's, while they
 * test it. Each is the SHA-256 (hex) of the account's email address in lower
 * case, so the addresses aren't in this public code; make one with
 * `printf %s you@example.com | sha256sum`. These accounts skip the
 * subscription page and keep their data like a subscriber, but get no server.
 */
const EXEMPT = new Set([
  "434633ce2df27abbb930fa08014a267046ef87c349456af49eefacaa07b51600", // the owner, while testing
]);

type State = Pick<Doc<"subscribers">, "livemode" | "subscriptionStatus" | "currentPeriodEnd" | "cancelAt">;

/** Whether Stripe runs in live mode (a live key is set) or test mode, or
 * undefined with no key. A subscription only counts in its own mode, so a test
 * subscription never opens Holly Bot once real payments are switched on. */
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether the account uses Holly Bot without a subscription (EXEMPT), by
 * its email address as Google or Apple verified it. */
export async function isExempt(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  const email = user?.email?.trim().toLowerCase();
  return !!email && user?.emailVerificationTime !== undefined && EXEMPT.has(await sha256(email));
}

/**
 * requireUserId, for an account whose subscription lets it use Holly Bot (or
 * that's exempt). Everything that keeps or uses an account's data starts here
 * (convex/data.ts, and connecting and running Gmail, Outlook and GitHub in
 * convex/connectors.ts). Signing in and out, the subscription itself,
 * deleting the account, unlinking a computer and disconnecting a service
 * work without one.
 */
export async function requireSubscriber(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  if (!hasAccess(await subscriberOf(ctx, userId)) && !(await isExempt(ctx, userId))) throw new ConvexError(INACTIVE);
  return userId;
}
