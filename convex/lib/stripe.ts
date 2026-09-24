// Stripe's REST API, for subscriptions (convex/billing.ts): plain functions
// over fetch, like the other services Holly Bot talks to, plus the check on
// the signature of Stripe's webhook calls. No imports: plain TypeScript.

type Fetch = typeof fetch;

const API = "https://api.stripe.com/v1";
/** Every call names the API version it was written against, so Stripe's
 * answers keep their shape whatever the account's default version is. */
export const API_VERSION = "2025-03-31.basil";

/** Stripe turned a request down. `code` is its error code (resource_missing…). */
export class StripeError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Params = { [name: string]: unknown };

/** Stripe's form encoding: nested objects and arrays as `name[key]=value`. */
export function encode(params: Params, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object") encode(item as Params, `${name}[${i}]`, out);
        else out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof value === "object") {
      encode(value as Params, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

/** One call to Stripe with the account's secret key. */
export async function call<T = any>(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
  opts: { idempotencyKey?: string; fetch?: Fetch } = {},
): Promise<T> {
  const form = encode(params).toString();
  const query = method === "POST" || !form ? "" : `?${form}`;
  const res = await (opts.fetch ?? fetch)(`${API}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : null),
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : null),
    },
    body: method === "POST" ? form : undefined,
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new StripeError(data?.error?.message || `Stripe answered ${res.status}`, res.status, data?.error?.code);
  return data as T;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a webhook call really comes from Stripe: its `Stripe-Signature`
 * header (`t=<seconds>,v1=<hex>,…`) holds an HMAC-SHA256 of `<t>.<body>` made
 * with the endpoint's signing secret, from the last five minutes (so a
 * recorded call can't be played back later).
 */
export async function verifySignature(body: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t") timestamp = value;
    else if (name === "v1" && value) signatures.push(value);
  }
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(seconds) || !signatures.length) return false;
  if (Math.abs(now / 1000 - seconds) > 300) return false;
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${timestamp}.${body}`)));
  return signatures.some((signature) => same(signature, expected));
}

/** A subscription as Holly Bot keeps it (times in ms). */
export interface SubscriptionState {
  subscriptionId: string;
  customerId: string;
  status: string;
  priceId?: string;
  productId?: string;
  interval?: string;
  /** When the period paid for ends. */
  periodEnd?: number;
  /** When it ended, or when it's set to end (cancelled at the end of the
   * period, or on a date). */
  endsAt?: number;
  /** The account it was bought for (its metadata, set at checkout). */
  userId?: string;
}

const idOf = (value: any): string | undefined => (typeof value === "string" ? value : value?.id);

/** The parts of a Stripe subscription Holly Bot keeps. The period's end is on
 * its item in this API version, and on the subscription in older ones. */
export function subscriptionState(sub: any): SubscriptionState {
  const item = sub?.items?.data?.[0];
  const price = item?.price;
  const end = item?.current_period_end ?? sub?.current_period_end;
  const periodEnd = typeof end === "number" ? end * 1000 : undefined;
  const at = (seconds: unknown) => (typeof seconds === "number" ? seconds * 1000 : undefined);
  const endsAt = at(sub?.ended_at) ?? at(sub?.cancel_at) ?? (sub?.cancel_at_period_end ? periodEnd : undefined);
  return {
    subscriptionId: String(sub?.id ?? ""),
    customerId: idOf(sub?.customer) ?? "",
    status: String(sub?.status ?? ""),
    priceId: idOf(price),
    productId: idOf(price?.product),
    interval: price?.recurring?.interval,
    periodEnd,
    endsAt,
    userId: typeof sub?.metadata?.userId === "string" ? sub.metadata.userId : undefined,
  };
}
