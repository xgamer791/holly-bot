// Holly Bot's plans: what each costs, and the dedicated server each runs on at
// Vultr. This is the one place they're set. The subscription page lists them
// (billing:status), checkout refuses a Stripe price that doesn't match them
// (convex/billing.ts), and each subscriber's server is made at its plan's size
// (convex/servers.ts). No imports: plain data.

export type PlanId = "starter" | "pro" | "ultra";
export type Interval = "month" | "year";

export interface Plan {
  id: PlanId;
  name: string;
  /** What it costs in US cents: month to month, or a year paid up front. */
  price: Record<Interval, number>;
  /** The server it runs on: its Vultr plan, and what that plan has. */
  server: string;
  cpu: number;
  memoryGb: number;
  /** A line under the name, for a plan that has one. */
  note?: string;
}

/** Month to month ($60, $120 or $200), or a year paid up front for less
 * ($490, $990 or $1,790). Smallest to largest: a later plan is an upgrade. */
export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", price: { month: 6000, year: 49000 }, server: "vc2-2c-4gb", cpu: 2, memoryGb: 4, note: "Best for 1 bot" },
  { id: "pro", name: "Pro", price: { month: 12000, year: 99000 }, server: "vc2-4c-8gb", cpu: 4, memoryGb: 8 },
  { id: "ultra", name: "Ultra", price: { month: 20000, year: 179000 }, server: "vc2-6c-16gb", cpu: 6, memoryGb: 16 },
];

/** Where subscribers' servers run, and how they're found at Vultr. */
export const SERVERS = {
  /** Chicago. */
  region: "ord",
  /** The operating system, found by name in GET /v2/os for its os_id. */
  os: "Ubuntu 24.04",
  /** Every subscriber's server carries this tag, and the label holly-<userId>. */
  tag: "holly-customer",
  labelPrefix: "holly-",
  /** Vultr caps the account at 30 servers and $1,000 a month; no new server
   * is made once this many exist. */
  max: 28,
  /** What the subscriber sees their server called (Settings → Bot Computer). */
  name: "Holly Server",
};

export function planById(id: string | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** A plan's place from smallest to largest (-1 for none): comparing two says
 * whether a change is an upgrade or a downgrade. */
export function rank(id: string | undefined): number {
  return PLANS.findIndex((plan) => plan.id === id);
}

/** The plan whose server is this Vultr plan. */
export function planOfServer(server: string | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.server === server);
}

/** The deployment variable that holds a plan's Stripe price id, e.g.
 * STRIPE_PRICE_STARTER_MONTHLY. */
export function priceVariable(plan: PlanId, interval: Interval): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval === "year" ? "YEARLY" : "MONTHLY"}`;
}
