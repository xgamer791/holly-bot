// Holly Bot's plans: what each costs and the server it runs on. The
// subscription page lists them as the server hands them out (billing:status),
// and Stripe bills prices made from them (convex/billing.ts), so this is the
// one place a price is set. No imports: plain data.

export type PlanId = "starter" | "pro" | "ultra";
export type Interval = "month" | "year";

export interface Plan {
  id: PlanId;
  name: string;
  /** What it costs, in US cents, billed monthly or yearly. */
  price: Record<Interval, number>;
  /** The dedicated server it runs on. */
  cpu: number;
  memoryGb: number;
  /** A line under the name, for a plan that has one. */
  note?: string;
}

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", price: { month: 4900, year: 49000 }, cpu: 2, memoryGb: 4, note: "Best for 1 bot" },
  { id: "pro", name: "Pro", price: { month: 9900, year: 99000 }, cpu: 4, memoryGb: 8 },
  { id: "ultra", name: "Ultra", price: { month: 17900, year: 179000 }, cpu: 6, memoryGb: 16 },
];

export const INTERVALS: Interval[] = ["month", "year"];

export function planById(id: string | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** Each plan's product at Stripe. Holly Bot makes it, with this id, the first
 * time someone subscribes to the plan. */
export function productId(plan: Plan): string {
  return `holly_bot_${plan.id}`;
}

/** The plan a Stripe product belongs to, if it's one of Holly Bot's. */
export function planOfProduct(product: string | undefined): Plan | undefined {
  return PLANS.find((plan) => productId(plan) === product);
}

/** The lookup key of a plan's price at Stripe, monthly or yearly. */
export function priceKey(plan: Plan, interval: Interval): string {
  return `${productId(plan)}_${interval}`;
}
