import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireUserId } from "./auth";

// Whether an account's subscription is active (convex/billing.ts keeps what
// Stripe says about it). Holly Bot's server keeps and uses an account's data
// only while it is: see requireSubscriber.

/** What the server says to an account without an active subscription. The
 * app and Holly Computer know it by "active subscription"
 * (src/account/cloud-db.js): nothing is lost, and changes wait on the device
 * until the subscription is active again. */
export const INACTIVE = "Holly Bot needs an active subscription. Choose a plan in the app to keep going.";

/** Stripe statuses that pay for Holly Bot. */
const PAID = new Set(["active", "trialing"]);
/** Statuses a subscription never leaves. */
export const ENDED = new Set(["canceled", "incomplete_expired"]);

/** Stripe starts a new period as the last one ends, and says so. A
 * subscription whose period ended longer ago than this, with no word from
 * Stripe since, no longer counts (the app asks Stripe as soon as the period
 * ends: see needsCheck). */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

type State = Pick<Doc<"subscriptions">, "status" | "periodEnd" | "endsAt">;

/** Whether Stripe runs in live mode (a live key is set) or test mode, or
 * undefined with no key. Only the current mode's customers and subscriptions
 * count, so a test subscription never opens Holly Bot once real payments are
 * switched on. */
export function liveMode(): boolean | undefined {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? /_live_/.test(key) : undefined;
}

export function isActive(sub: State, now = Date.now()): boolean {
  if (!PAID.has(sub.status)) return false;
  if (sub.endsAt !== undefined && sub.endsAt <= now) return false;
  return sub.periodEnd === undefined || sub.periodEnd + GRACE_MS > now;
}

/** A paid subscription whose period (or the subscription) should have ended
 * by now: Stripe hasn't said what happened, so it's worth asking. */
export function needsCheck(sub: State, now = Date.now()): boolean {
  return PAID.has(sub.status) && ((sub.periodEnd !== undefined && sub.periodEnd <= now) || (sub.endsAt !== undefined && sub.endsAt <= now));
}

/** The account's subscriptions in the current Stripe mode. */
export async function subscriptionsOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"subscriptions">[]> {
  const live = liveMode();
  const rows = await ctx.db.query("subscriptions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  return live === undefined ? rows : rows.filter((row) => row.livemode === live);
}

/** The account's customer at Stripe in the current mode, if it has one yet. */
export async function customerOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"billingCustomers"> | null> {
  const live = liveMode();
  const rows = await ctx.db.query("billingCustomers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  return rows.find((row) => live === undefined || row.livemode === live) ?? null;
}

export async function hasActiveSubscription(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<boolean> {
  const now = Date.now();
  return (await subscriptionsOf(ctx, userId)).some((sub) => isActive(sub, now));
}

/**
 * requireUserId, for an account with an active subscription. Everything that
 * keeps or uses an account's data starts here (convex/data.ts, and connecting
 * and running Gmail, Outlook and GitHub in convex/connectors.ts). Signing in
 * and out, the subscription itself, deleting the account, unlinking a
 * computer and disconnecting a service work without one.
 */
export async function requireSubscriber(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  if (!(await hasActiveSubscription(ctx, userId))) throw new ConvexError(INACTIVE);
  return userId;
}
