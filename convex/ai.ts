import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { MODELS, OPENROUTER, costOf, effortFor, promptTokens, usageOf, type Usage, type Via } from "./lib/credits";

// Holly Bot's AI: DeepSeek's models on Holly Bot's own account, paid for with
// each account's monthly credits (convex/credits.ts). They run on OpenRouter
// when OPENROUTER_API_KEY is set, or else on DeepSeek's own API with
// DEEPSEEK_API_KEY. The app and Holly Computer send their bots' chat requests
// here, in DeepSeek's form (src/core/providers), with the account's session
// in place of a key. This lets a request through while the account has
// credits, passes it on, streams the answer back as it comes (in DeepSeek's
// form, whichever ran it), and charges what it cost. The keys never leave the
// server, and nothing of the request is kept: only what it cost and how many
// tokens it used.

const SITE = "https://xgamer791.github.io/holly-bot/";

/** Where requests go, and with which key: OpenRouter's first. */
function upstream(): { via: Via; url: string; key: string; keyName: string; label: string } | null {
  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) return { via: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: openrouter, keyName: "OPENROUTER_API_KEY", label: "OpenRouter" };
  const deepseek = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepseek) return { via: "deepseek", url: "https://api.deepseek.com/chat/completions", key: deepseek, keyName: "DEEPSEEK_API_KEY", label: "DeepSeek" };
  return null;
}

/** What a chat request may carry on; anything else is left out. */
const PASSED = [
  "messages", "tools", "tool_choice", "temperature", "top_p", "stop", "response_format",
  "thinking", "reasoning_effort", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs",
];

/** The most output a request may ask for, and what it gets when it doesn't say. */
const MAX_TOKENS = 65_536;
const DEFAULT_TOKENS = 8_192;

// Requests carry the session as a bearer token, never a cookie, so any page may send one.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

/** A refusal the app shows as it is: `type` says it's Holly Bot's own, `code` what happened. */
function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "holly_bot", code } }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** OpenRouter or DeepSeek turned a request down: in words for the app, and,
 * when it's Holly Bot's key or balance at fault, in the logs for the owner. */
async function fromUpstream(res: Response, up: { label: string; keyName: string }): Promise<Response> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    detail = JSON.parse(text)?.error?.message || detail;
  } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    console.error(`${up.label} refused Holly Bot's key (${res.status}: ${detail}). ${res.status === 402 ? `Top up the ${up.label} balance.` : `Check ${up.keyName}.`}`);
    return refuse(503, "unavailable", "Holly Bot's AI is unavailable right now. Try again soon.");
  }
  if (res.status === 429) return refuse(429, "busy", "Holly Bot's AI is busy right now. Try again in a moment.");
  if (res.status >= 500) return refuse(502, "unavailable", "Holly Bot's AI had a problem answering. Try again in a moment.");
  console.warn(`${up.label} turned a request down (${res.status}: ${detail})`);
  return refuse(res.status, "deepseek", `Holly Bot's AI couldn't take that request: ${detail || `error ${res.status}`}`);
}

/**
 * Which of OpenRouter's providers may run a request: only ones that don't
 * keep what they're sent or train on it, which leaves out DeepSeek's own API.
 * Among them OpenRouter picks by price and uptime, and, for requests with
 * tools, by how reliably each calls them.
 */
const PROVIDER = { data_collection: "deny" };

/**
 * A request in DeepSeek's form as OpenRouter takes it: OpenRouter's name for
 * the model, DeepSeek's `thinking` and `reasoning_effort` as OpenRouter's
 * `reasoning` (earlier answers' `reasoning_content` it takes as it is), the
 * providers it may use, and `session`, which keeps the account's requests on
 * one provider, where its input is cached.
 */
function forOpenRouter(out: Record<string, any>, model: string, session: string): Record<string, any> {
  const { thinking, reasoning_effort: effort, stream_options: _usageIsAlwaysSent, ...rest } = out;
  const off = thinking?.type === "disabled";
  return {
    ...rest,
    model: OPENROUTER[model].id,
    reasoning: off ? { enabled: false } : { enabled: true, ...(typeof effort === "string" ? { effort: effortFor(model, effort) } : {}) },
    provider: PROVIDER,
    session_id: session,
  };
}

/** The account's key for OpenRouter's sticky routing: its id, hashed. */
async function sessionOf(userId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`holly-bot:${userId}`));
  return Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An answer from OpenRouter in DeepSeek's form, the way the app reads it:
 * the model's own name, and its reasoning as `reasoning_content` (which the
 * app keeps to send back while tools run). `part` is a streamed event's
 * `delta` or a whole answer's `message`. */
function asDeepSeek(event: any, model: string, part: "delta" | "message"): any {
  if (event && typeof event === "object") {
    if (event.model) event.model = model;
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      const said = choice?.[part];
      if (!said || typeof said.reasoning !== "string") continue;
      if (said.reasoning_content == null) said.reasoning_content = said.reasoning;
      delete said.reasoning;
      delete said.reasoning_details;
    }
  }
  return event;
}

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

/** POST /ai/chat/completions (convex/http.ts): a bot's chat request. */
export const chat = httpAction(async (ctx, request) => {
  const up = upstream();
  if (!up) return refuse(503, "not_set_up", "Holly Bot's AI isn't set up on its server yet.");
  // A token Convex can't verify (expired, or not one of its own) throws here:
  // that's "not signed in" too, so the app renews its session and asks again.
  let userId: Awaited<ReturnType<typeof getAuthUserId>> = null;
  let sessionId: Awaited<ReturnType<typeof getAuthSessionId>> = null;
  try {
    userId = await getAuthUserId(ctx);
    sessionId = await getAuthSessionId(ctx);
  } catch { /* below */ }
  if (!userId || !sessionId) return refuse(401, "not_signed_in", "Sign in to Holly Bot to use its AI.");

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "bad_request", "That request isn't JSON.");
  }
  const model = String(body?.model ?? "");
  if (!MODELS.includes(model)) return refuse(400, "bad_model", `Holly Bot's AI runs DeepSeek V4.1 Flash and V4 Pro, not ${model || "that model"}.`);

  const stream = body.stream === true;
  const out: Record<string, any> = { model };
  for (const name of PASSED) if (body[name] !== undefined) out[name] = body[name];
  out.max_tokens = Math.min(MAX_TOKENS, Math.max(1, Math.floor(Number(body.max_tokens) || DEFAULT_TOKENS)));
  if (stream) Object.assign(out, { stream: true, stream_options: { include_usage: true } });
  const sent = up.via === "openrouter" ? forOpenRouter(out, model, await sessionOf(userId)) : out;

  // Held back while it runs: the most it could cost (all its input new, and
  // all the output it may ask for).
  const prompt = promptTokens(out);
  const hold = costOf(model, { cached: 0, fresh: prompt, output: out.max_tokens }, Date.now(), up.via);
  let admitted;
  try {
    admitted = await ctx.runMutation(internal.credits.admit, { userId, sessionId, hold });
  } catch (err) {
    console.error(`Letting ${userId}'s request in failed: ${err instanceof Error ? err.message : err}`);
    return refuse(503, "unavailable", "Holly Bot's AI couldn't take that request. Try again in a moment.");
  }
  if (!admitted.ok) return refuse(admitted.status, admitted.code, admitted.message);
  const { held } = admitted;
  const charge = (used: Usage | null, output = 0) =>
    ctx.runMutation(internal.credits.charge, {
      userId,
      model,
      at: Date.now(),
      held,
      via: up.via,
      ...(used ? { usage: used } : { estimate: { prompt, output } }),
    }).catch((err) => console.error(`Charging ${userId} for a request failed: ${err instanceof Error ? err.message : err}`));

  let response: Response;
  try {
    response = await fetch(up.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${up.key}`,
        "Content-Type": "application/json",
        ...(up.via === "openrouter" ? { "HTTP-Referer": SITE, "X-Title": "Holly Bot" } : {}),
      },
      body: JSON.stringify(sent),
    });
  } catch {
    await charge({ cached: 0, fresh: 0, output: 0 });
    return refuse(502, "unavailable", "Couldn't reach Holly Bot's AI. Try again in a moment.");
  }
  if (!response.ok || !response.body) {
    await charge({ cached: 0, fresh: 0, output: 0 });
    return await fromUpstream(response, up);
  }

  if (!stream) {
    const data = await response.json().catch(() => null);
    await charge(usageOf(data?.usage));
    return new Response(JSON.stringify(up.via === "openrouter" ? asDeepSeek(data, model, "message") : data), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // The answer goes back to the app line by line as it comes, in DeepSeek's
  // form. Its last event says what the request used (and, on OpenRouter, what
  // it cost); that's charged before the stream ends. If the app goes away
  // first, the upstream is stopped too, and what was sent is estimated.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const source = response.body;
  const pump = async () => {
    const writer = writable.getWriter();
    const reader = source.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let used: Usage | null = null;
    let outputChars = 0;
    const relay = (line: string): string => {
      const text = line.trim();
      if (!text.startsWith("data:")) return line;
      const data = text.slice(5).trim();
      if (!data || data === "[DONE]") return line;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        return line; // not JSON: it goes on as it was
      }
      used = usageOf(event?.usage) ?? used;
      const delta = event?.choices?.[0]?.delta;
      if (delta) {
        outputChars += String(delta.content ?? "").length + String(delta.reasoning_content ?? delta.reasoning ?? "").length;
        if (delta.tool_calls) outputChars += JSON.stringify(delta.tool_calls).length;
      }
      if (up.via !== "openrouter") return line;
      return `data: ${JSON.stringify(asDeepSeek(event, model, "delta"))}${line.endsWith("\n") ? "\n" : ""}`;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode();
          if (pending) await writer.write(encoder.encode(relay(pending)));
          break;
        }
        pending += decoder.decode(value, { stream: true });
        let lines = "";
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          lines += relay(pending.slice(0, nl + 1));
          pending = pending.slice(nl + 1);
        }
        if (!lines) continue;
        try {
          await writer.write(encoder.encode(lines));
        } catch {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      console.warn(`AI stream for ${userId} ended early: ${err instanceof Error ? err.message : err}`);
    } finally {
      await charge(used, Math.ceil(outputChars / 4));
      await writer.close().catch(() => {});
    }
  };
  void pump();
  return new Response(readable, {
    status: 200,
    headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
});
