/// <reference types="vite/client" />
// Holly Bot's AI and AI credits (convex/ai.ts, convex/credits.ts,
// convex/lib/credits.ts) on convex-test's stand-in for the Convex backend,
// with DeepSeek answering the way its API does: a streamed answer passed
// through and charged exactly what DeepSeek says it used, holds, refusals
// (at zero, signed out, no plan, not set up), refills and plan changes, and
// the month and price maths. npm run test:convex.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { addMonths, anchorFor, costOf, deepseekPeak, periodOf, refillIn, settle, usageOf } from "../../convex/lib/credits";

const modules = import.meta.glob("../../convex/**/*.*s");

/** A Saturday: off-peak all day, so DeepSeek's prices are halved. */
const SATURDAY = new Date("2026-09-26T12:00:00Z");
/** Starter's month of credits, $10, in millionths of a dollar. */
const STARTER = 10_000_000;
const PRO = 20_000_000;

type T = ReturnType<typeof convexTest>;

/** A signed-in account on a plan, called as its session. */
async function signIn(t: T, { plan = "starter", status = "active" } = {}) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
    await ctx.db.insert("subscribers", {
      userId,
      livemode: false,
      stripeCustomerId: `cus_${userId}`,
      stripeSubscriptionId: `sub_${userId}`,
      plan,
      billingInterval: "month",
      subscriptionStatus: status,
      currentPeriodEnd: Date.now() + 20 * 86_400_000,
      serverStatus: "ready",
      updatedAt: Date.now(),
    });
    return { userId, sessionId };
  });
  return { userId, sessionId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

/** DeepSeek: `answer` handles each request; all are kept. */
function deepseek(answer: (body: any) => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    calls.push({ url, headers: new Headers(init.headers), body });
    return answer(body);
  });
  return calls;
}

const sse = (events: unknown[], done = true) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

/** What DeepSeek says a request used: 10,000 tokens it had cached, 2,000 new, 500 out. */
const USAGE = { prompt_tokens: 12_000, completion_tokens: 500, prompt_cache_hit_tokens: 10_000, prompt_cache_miss_tokens: 2_000 };

/** A streamed answer, "Hello there", with DeepSeek's usage last unless `usage` is null. */
function streamed(usage: unknown = USAGE) {
  return new Response(
    sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      { choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }] },
      ...(usage ? [{ choices: [], usage }] : []),
    ], !!usage),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const ask = (body: Record<string, unknown> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "Hi" }], stream: true, max_tokens: 32_768, ...body }),
});

async function ledger(t: T, userId: Id<"users">) {
  return t.run((ctx) => ctx.db.query("credits").withIndex("by_user", (q) => q.eq("userId", userId)).unique());
}

/** Sets the account's credits this month. */
async function setCredits(t: T, userId: Id<"users">, fields: { balance: number; periodEnd?: number; allowance?: number }) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("credits", {
      userId,
      anchor: addMonths(now, -1),
      periodStart: now - 86_400_000,
      periodEnd: fields.periodEnd ?? now + 20 * 86_400_000,
      allowance: fields.allowance ?? STARTER,
      balance: fields.balance,
      spent: 0,
      requests: 0,
      cachedTokens: 0,
      freshTokens: 0,
      outputTokens: 0,
      updatedAt: now,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SATURDAY);
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-holly");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Holly Bot's AI", () => {
  test("a streamed answer comes back as DeepSeek sent it, and costs exactly what it used", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    const calls = deepseek(() => streamed());
    const res = await as.fetch("/ai/chat/completions", ask({ thinking: { type: "disabled" }, stream_options: { include_usage: true }, user: "someone" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"Hello"');
    expect(text).toContain('" there"');
    expect(text).toContain("[DONE]");

    // DeepSeek got Holly Bot's key and only the parameters it takes.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-holly");
    expect(calls[0].body).toMatchObject({ model: "deepseek-flash", stream: true, stream_options: { include_usage: true }, thinking: { type: "disabled" }, max_tokens: 32_768 });
    expect(calls[0].body.user).toBeUndefined();

    // 10,000 cached × $0.006 + 2,000 new × $0.30 + 500 out × $1.20 per million, halved off-peak.
    const cost = Math.ceil((10_000 * 0.006 + 2_000 * 0.3 + 500 * 1.2) / 2);
    expect(cost).toBe(630);
    expect(await as.query(api.credits.mine, {})).toMatchObject({ ready: true, allowance: STARTER, balance: STARTER - cost });
    expect(await ledger(t, userId)).toMatchObject({ balance: STARTER - cost, spent: cost, requests: 1, cachedTokens: 10_000, freshTokens: 2_000, outputTokens: 500 });
  });

  test("at peak hours it costs full price", async () => {
    vi.setSystemTime(new Date("2026-09-28T02:30:00Z")); // a Monday, 02:30 UTC
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => streamed());
    await (await as.fetch("/ai/chat/completions", ask())).text();
    expect((await ledger(t, userId))?.spent).toBe(Math.ceil(10_000 * 0.006 + 2_000 * 0.3 + 500 * 1.2));
  });

  test("an answer asked for without streaming is charged the same way", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi" } }], usage: USAGE }), { headers: { "content-type": "application/json" } }));
    const res = await as.fetch("/ai/chat/completions", ask({ stream: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("Hi");
    expect((await ledger(t, userId))?.spent).toBe(630);
  });

  test("an answer cut off before DeepSeek said what it used is charged an estimate", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => streamed(null));
    await (await as.fetch("/ai/chat/completions", ask())).text();
    const row = await ledger(t, userId);
    expect(row?.requests).toBe(1);
    expect(row?.spent).toBeGreaterThan(0);
    expect(row?.balance).toBe(STARTER - row!.spent);
  });

  test("Pro costs more than Flash for the same use", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => streamed());
    await (await as.fetch("/ai/chat/completions", ask({ model: "deepseek-v4-pro" }))).text();
    expect((await ledger(t, userId))?.spent).toBe(Math.ceil((10_000 * 0.044 + 2_000 * 1.32 + 500 * 3.96) / 2));
  });

  test("at zero, bots pause until the refill, and DeepSeek isn't asked", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    await setCredits(t, userId, { balance: 0, periodEnd: Date.now() + 3 * 86_400_000 });
    const calls = deepseek(() => streamed());
    const res = await as.fetch("/ai/chat/completions", ask());
    expect(res.status).toBe(402);
    const { error } = await res.json();
    expect(error).toMatchObject({ type: "holly_bot", code: "no_credits" });
    expect(error.message).toBe("Your AI credits for this month are used up. Your bots pause until they refill, in 3 days.");
    expect(calls).toHaveLength(0);
    expect(await as.query(api.credits.mine, {})).toMatchObject({ balance: 0 });
  });

  test("the hold keeps requests at once from spending more than is left", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await signIn(t);
    await setCredits(t, userId, { balance: 5_000 });
    expect(await t.mutation(internal.credits.admit, { userId, sessionId, hold: 80_000 })).toEqual({ ok: true, held: 5_000 });
    expect(await t.mutation(internal.credits.admit, { userId, sessionId, hold: 80_000 })).toMatchObject({ ok: false, status: 402, code: "no_credits" });
    // Charging the first gives its hold back and takes what it cost.
    const cost = await t.mutation(internal.credits.charge, { userId, model: "deepseek-flash", at: Date.now(), held: 5_000, usage: { cached: 0, fresh: 1_000, output: 100 } });
    expect(cost).toBe(Math.ceil((1_000 * 0.3 + 100 * 1.2) / 2));
    expect((await ledger(t, userId))?.balance).toBe(5_000 - cost);
  });

  test("DeepSeek turning Holly Bot's key down reads as unavailable, and costs nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => new Response(JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }), { status: 402 }));
    const res = await as.fetch("/ai/chat/completions", ask());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "unavailable", message: "Holly Bot's AI is unavailable right now. Try again soon." });
    expect((await ledger(t, userId))?.balance).toBe(STARTER);
  });

  test("DeepSeek's own refusals of a request come through in its words", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    deepseek(() => new Response(JSON.stringify({ error: { message: "This model's maximum context length is 1000000 tokens" } }), { status: 400 }));
    const res = await as.fetch("/ai/chat/completions", ask());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("maximum context length");
    expect((await ledger(t, userId))?.balance).toBe(STARTER);
  });

  test("only DeepSeek V4.1 Flash and V4 Pro", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signIn(t);
    const calls = deepseek(() => streamed());
    const res = await as.fetch("/ai/chat/completions", ask({ model: "gpt-5" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_model");
    expect(calls).toHaveLength(0);
  });

  test("signed out, a session that ended, or no subscription: refused", async () => {
    const t = convexTest(schema, modules);
    const calls = deepseek(() => streamed());
    const anonymous = await t.fetch("/ai/chat/completions", ask());
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("not_signed_in");

    const ended = await signIn(t);
    await t.run((ctx) => ctx.db.delete(ended.sessionId));
    const gone = await ended.as.fetch("/ai/chat/completions", ask());
    expect(gone.status).toBe(401);

    const lapsed = await signIn(t, { status: "canceled" });
    const unpaid = await lapsed.as.fetch("/ai/chat/completions", ask());
    expect(unpaid.status).toBe(402);
    expect((await unpaid.json()).error.code).toBe("not_subscribed");
    expect(await lapsed.as.query(api.credits.mine, {})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("without Holly Bot's DeepSeek key it says it isn't set up, and the app keeps to saved keys", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const t = convexTest(schema, modules);
    const { as } = await signIn(t);
    const res = await as.fetch("/ai/chat/completions", ask());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("not_set_up");
    expect(await as.query(api.credits.mine, {})).toMatchObject({ ready: false, balance: STARTER });
  });

  test("the browser's preflight is answered", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/ai/chat/completions", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});

describe("AI credits", () => {
  test("a new month refills them, and what was left doesn't carry over", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, as } = await signIn(t);
    await setCredits(t, userId, { balance: 1_234, periodEnd: Date.now() - 1_000 });
    expect(await as.query(api.credits.mine, {})).toMatchObject({ balance: STARTER });
    await t.mutation(internal.credits.admit, { userId, sessionId, hold: 0 });
    const row = await ledger(t, userId);
    expect(row).toMatchObject({ balance: STARTER, spent: 0, requests: 0 });
    expect(row!.periodEnd).toBeGreaterThan(Date.now());
  });

  test("an upgrade adds the difference; a downgrade caps what's left", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, as } = await signIn(t);
    await setCredits(t, userId, { balance: 4_000_000 });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subscribers").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(sub!._id, { plan: "pro" });
    });
    expect(await as.query(api.credits.mine, {})).toMatchObject({ allowance: PRO, balance: 14_000_000 });
    await t.mutation(internal.credits.admit, { userId, sessionId, hold: 0 });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subscribers").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(sub!._id, { plan: "starter" });
    });
    expect(await as.query(api.credits.mine, {})).toMatchObject({ allowance: STARTER, balance: STARTER });
  });

  test("a new account's month starts on the day its plan renews", async () => {
    const t = convexTest(schema, modules);
    const { as } = await signIn(t);
    const mine = await as.query(api.credits.mine, {});
    // The plan renews in 20 days, so the credits refill then.
    expect(mine?.refillsAt).toBe(Date.now() + 20 * 86_400_000);
    expect(mine?.balance).toBe(STARTER);
  });

  test("deleting the account deletes its credits", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signIn(t);
    await setCredits(t, userId, { balance: 42 });
    while (!(await as.mutation(api.account.deleteAccount, {})).done);
    expect(await ledger(t, userId)).toBeNull();
  });
});

describe("the maths", () => {
  const at = (s: string) => new Date(s).getTime();

  test("months keep their day, or the month's last", () => {
    expect(addMonths(at("2026-01-31T10:00:00Z"), 1)).toBe(at("2026-02-28T10:00:00Z"));
    expect(addMonths(at("2028-01-31T10:00:00Z"), 1)).toBe(at("2028-02-29T10:00:00Z"));
    expect(addMonths(at("2026-03-31T10:00:00Z"), -1)).toBe(at("2026-02-28T10:00:00Z"));
    expect(addMonths(at("2026-12-15T00:00:00Z"), 1)).toBe(at("2027-01-15T00:00:00Z"));
  });

  test("the month of credits a moment is in", () => {
    const anchor = at("2026-01-31T10:00:00Z");
    expect(periodOf(anchor, at("2026-03-01T00:00:00Z"))).toEqual({ start: at("2026-02-28T10:00:00Z"), end: at("2026-03-31T10:00:00Z") });
    expect(periodOf(anchor, at("2026-02-28T09:00:00Z"))).toEqual({ start: anchor, end: at("2026-02-28T10:00:00Z") });
    expect(periodOf(anchor, anchor)).toEqual({ start: anchor, end: at("2026-02-28T10:00:00Z") });
  });

  test("months start on the renewal day, monthly on a yearly plan too", () => {
    const now = at("2026-09-26T12:00:00Z");
    expect(anchorFor(at("2026-10-25T08:00:00Z"), now)).toBe(at("2026-09-25T08:00:00Z"));
    expect(anchorFor(at("2027-09-25T08:00:00Z"), now)).toBe(at("2026-09-25T08:00:00Z"));
    expect(anchorFor(undefined, now)).toBe(now);
  });

  test("settling: refills, plan changes, and nothing to do", () => {
    const now = at("2026-09-26T12:00:00Z");
    const first = settle(null, STARTER, at("2026-09-25T08:00:00Z"), now);
    expect(first).toMatchObject({ balance: STARTER, allowance: STARTER, periodEnd: at("2026-10-25T08:00:00Z") });
    expect(settle({ ...first, balance: 7 }, STARTER, 0, now).balance).toBe(7);
    expect(settle({ ...first, balance: 7 }, STARTER, 0, at("2026-10-25T08:00:00Z")).balance).toBe(STARTER);
    expect(settle({ ...first, balance: 2_000_000 }, PRO, 0, now).balance).toBe(12_000_000);
    expect(settle({ ...first, allowance: PRO, balance: 15_000_000 }, STARTER, 0, now).balance).toBe(STARTER);
  });

  test("DeepSeek's peak hours and prices", () => {
    expect(deepseekPeak(at("2026-09-28T02:00:00Z"))).toBe(true); // Monday
    expect(deepseekPeak(at("2026-09-28T05:00:00Z"))).toBe(false);
    expect(deepseekPeak(at("2026-09-28T09:59:00Z"))).toBe(true);
    expect(deepseekPeak(at("2026-09-26T02:00:00Z"))).toBe(false); // Saturday
    const used = { cached: 1_000_000, fresh: 1_000_000, output: 1_000_000 };
    expect(costOf("deepseek-flash", used, at("2026-09-28T02:00:00Z"))).toBe(1_506_000); // $0.006 + $0.30 + $1.20
    expect(costOf("deepseek-flash", used, at("2026-09-26T02:00:00Z"))).toBe(753_000);
  });

  test("reading DeepSeek's usage", () => {
    expect(usageOf(USAGE)).toEqual({ cached: 10_000, fresh: 2_000, output: 500 });
    expect(usageOf({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } })).toEqual({ cached: 40, fresh: 60, output: 5 });
    expect(usageOf(null)).toBeNull();
    expect(usageOf({ prompt_tokens: 3 })).toBeNull();
  });

  test("when they refill, in words", () => {
    expect(refillIn(3 * 86_400_000, 0)).toBe("in 3 days");
    expect(refillIn(5 * 3_600_000, 0)).toBe("within a day");
    expect(refillIn(30 * 3_600_000, 0)).toBe("in a day");
  });
});
