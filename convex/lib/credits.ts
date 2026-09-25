// AI credits (convex/credits.ts, convex/ai.ts): what a request to Holly Bot's
// AI costs, and each account's month of credits. Amounts are millionths of a
// US dollar; plans give credits in cents (convex/lib/plans.ts), and the app
// shows 1 credit per cent. The AI runs on OpenRouter, which says exactly what
// each request cost, or on DeepSeek's own API, whose use is priced here (as
// is a request cut off before OpenRouter said). No imports: plain functions.

/** Millionths of a dollar in a cent. */
export const MICROS_PER_CENT = 10_000;

/**
 * DeepSeek's list prices in US dollars per million tokens at peak hours
 * (off-peak is half price: deepseekPeak): input it had cached, other input,
 * and output. A price per million tokens is also a price in millionths of a
 * dollar per token. Keep them in step with DeepSeek's pricing page (and
 * src/core/pricing.js).
 */
export const PRICES: Record<string, { cached: number; input: number; output: number }> = {
  "deepseek-flash": { cached: 0.006, input: 0.3, output: 1.2 },
  "deepseek-v4-pro": { cached: 0.044, input: 1.32, output: 3.96 },
};

/** The models Holly Bot's AI runs, by the app's names for them. */
export const MODELS = Object.keys(PRICES);

/**
 * The same models on OpenRouter: its names for the releases DeepSeek's own
 * API serves, and the reasoning efforts it takes for them, lowest first.
 */
export const OPENROUTER: Record<string, { id: string; efforts: string[] }> = {
  "deepseek-flash": { id: "deepseek/deepseek-v4.1-flash", efforts: ["low", "high", "max"] },
  "deepseek-v4-pro": { id: "deepseek/deepseek-v4-pro-0813", efforts: ["low", "high", "max"] },
};

/** The reasoning effort OpenRouter takes for `model` nearest the app's (low, high or max). */
export function effortFor(model: string, effort: string): string {
  const efforts = OPENROUTER[model]?.efforts ?? ["high"];
  if (efforts.includes(effort)) return effort;
  if (effort === "max" || effort === "xhigh") return efforts[efforts.length - 1];
  if (effort === "low" || effort === "minimal") return efforts[0];
  return efforts.includes("high") ? "high" : efforts[efforts.length - 1];
}

/** DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function deepseekPeak(at: number): boolean {
  const d = new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Tokens a request used: input the model had cached, other input, and
 * output; and `cost`, what it came to in millionths of a dollar, when the
 * service said (OpenRouter does). */
export interface Usage {
  cached: number;
  fresh: number;
  output: number;
  cost?: number;
}

/** A response's `usage` (DeepSeek's or OpenRouter's), or null when it has none. */
export function usageOf(u: any): Usage | null {
  if (!u || typeof u !== "object" || u.completion_tokens == null) return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0;
  const fresh = Number(u.prompt_cache_miss_tokens ?? Math.max(0, prompt - cached)) || 0;
  const dollars = u.cost == null || u.cost === "" ? NaN : Number(u.cost);
  return { cached, fresh, output: Number(u.completion_tokens) || 0, ...(Number.isFinite(dollars) && dollars >= 0 ? { cost: Math.ceil(dollars * 1_000_000) } : {}) };
}

/** Where Holly Bot's AI runs: OpenRouter, or DeepSeek's own API. */
export type Via = "openrouter" | "deepseek";

/** What `usage` of `model` costs at time `at`, in millionths of a dollar:
 * what the service said, or else DeepSeek's list prices, half price off-peak
 * on DeepSeek's own API (OpenRouter's providers have no off-peak hours). An
 * unknown model is charged at the dearest one's. */
export function costOf(model: string, usage: Usage, at: number, via: Via = "deepseek"): number {
  if (usage.cost != null) return usage.cost;
  const p = PRICES[model] ?? PRICES["deepseek-v4-pro"];
  const full = usage.cached * p.cached + usage.fresh * p.input + usage.output * p.output;
  return Math.ceil(via === "deepseek" && !deepseekPeak(at) ? full / 2 : full);
}

/** A rough count of the tokens in a chat request's input: about 4 characters
 * of text a token, and an image as 1,000 (its base64 isn't text it reads). */
export function promptTokens(body: { messages?: unknown; tools?: unknown }): number {
  let chars = body.tools ? JSON.stringify(body.tools).length : 0;
  let images = 0;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const content = (m as any)?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "image_url") images += 1;
        else chars += String(part?.text ?? "").length;
      }
    }
    chars += String((m as any)?.reasoning_content ?? "").length;
    if ((m as any)?.tool_calls) chars += JSON.stringify((m as any).tool_calls).length;
  }
  return Math.ceil(chars / 4) + images * 1000;
}

/** An account's credits, as the `credits` table keeps them (convex/schema.ts). */
export interface Ledger {
  /** Where its months start counting from. */
  anchor: number;
  periodStart: number;
  /** When the credits refill. */
  periodEnd: number;
  /** What they refill to: the plan's allowance. */
  allowance: number;
  /** What's left; below zero when a request cost more than was left. */
  balance: number;
  /** This month's: spent, requests, and the tokens they used. */
  spent: number;
  requests: number;
  cachedTokens: number;
  freshTokens: number;
  outputTokens: number;
}

/** `t` moved by `n` months: the same day of the month (or that month's last
 * day) at the same time, in UTC. */
export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The month of credits `now` is in, counting months from `anchor`. */
export function periodOf(anchor: number, now: number): { start: number; end: number } {
  const a = new Date(anchor);
  const b = new Date(now);
  let n = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (addMonths(anchor, n) > now) n -= 1;
  n = Math.max(0, n);
  return { start: addMonths(anchor, n), end: addMonths(anchor, n + 1) };
}

/** Where a new account's months start: the day its paid period renews on, so
 * the credits refill as it's billed (monthly on a yearly plan too), or `now`. */
export function anchorFor(periodEnd: number | undefined, now: number): number {
  if (!periodEnd) return now;
  for (let k = 0; k <= 24; k++) {
    const t = addMonths(periodEnd, -k);
    if (t <= now) return t;
  }
  return now;
}

/**
 * The credits as they stand at `now`, for a plan whose allowance is
 * `allowance`. A new month refills them (what was left doesn't carry over).
 * A plan changed during the month adds the difference when it's bigger, and
 * caps what's left when it's smaller. `row` null: the account's first month,
 * from `anchor`.
 */
export function settle(row: Ledger | null, allowance: number, anchor: number, now: number): Ledger {
  const fresh = { spent: 0, requests: 0, cachedTokens: 0, freshTokens: 0, outputTokens: 0 };
  if (!row) {
    const { start, end } = periodOf(anchor, now);
    return { anchor, periodStart: start, periodEnd: end, allowance, balance: allowance, ...fresh };
  }
  if (now >= row.periodEnd) {
    const { start, end } = periodOf(row.anchor, now);
    return { ...row, periodStart: start, periodEnd: end, allowance, balance: allowance, ...fresh };
  }
  if (allowance !== row.allowance) {
    const balance = allowance > row.allowance ? row.balance + (allowance - row.allowance) : Math.min(row.balance, allowance);
    return { ...row, allowance, balance };
  }
  return row;
}

/** A request's use when DeepSeek never said (the answer was cut off): its
 * input split the way the account's own was cached this month. */
export function estimateUsage(prompt: number, output: number, ledger: Ledger): Usage {
  const seen = ledger.cachedTokens + ledger.freshTokens;
  const cached = seen > 0 ? Math.round((prompt * ledger.cachedTokens) / seen) : 0;
  return { cached, fresh: Math.max(0, prompt - cached), output };
}

/** When the credits refill, in words that don't depend on a time zone. */
export function refillIn(at: number, now: number): string {
  const ms = at - now;
  if (ms < 86_400_000) return "within a day";
  const days = Math.round(ms / 86_400_000);
  return days <= 1 ? "in a day" : `in ${days} days`;
}
