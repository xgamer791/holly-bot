import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { MODELS, RENAMED, costOf, promptTokens, usageOf, type Usage } from "./lib/credits";

// Holli Bot's AI: DeepSeek, on Holli Bot's own key (DEEPSEEK_API_KEY), paid
// for with each account's monthly credits (convex/credits.ts). The app and
// Holli Bot Computer send their bots' OpenAI-style chat requests here
// (src/core/providers) with the account's session in place of a key. This
// lets a request through while the account has credits, passes it on to
// DeepSeek, streams the answer back as it comes, and charges what DeepSeek
// says the request used. The key never leaves the server, and nothing of the
// request is kept: only what it cost and how many tokens it used.

const DEEPSEEK = "https://api.deepseek.com";

/** What a chat request may carry on to DeepSeek; anything else is left out. */
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

/** A refusal the app shows as it is: `type` says it's Holli Bot's own, `code` what happened. */
function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "holly_bot", code } }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** DeepSeek turned a request down: in words for the app, and, when it's Holli
 * Bot's key or DeepSeek balance at fault, in the logs for the owner. */
async function fromDeepSeek(res: Response): Promise<Response> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    detail = JSON.parse(text)?.error?.message || detail;
  } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    console.error(`DeepSeek refused Holli Bot's key (${res.status}: ${detail}). ${res.status === 402 ? "Top up the DeepSeek balance." : "Check DEEPSEEK_API_KEY."}`);
    return refuse(503, "unavailable", "Holli Bot's AI is unavailable right now. Try again soon.");
  }
  if (res.status === 429) return refuse(429, "busy", "DeepSeek is busy right now. Try again in a moment.");
  if (res.status >= 500) return refuse(502, "unavailable", "DeepSeek had a problem answering. Try again in a moment.");
  return refuse(res.status, "deepseek", `DeepSeek couldn't take that request: ${detail || `error ${res.status}`}`);
}

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

/** POST /ai/chat/completions (convex/http.ts): a bot's chat request. */
export const chat = httpAction(async (ctx, request) => {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) return refuse(503, "not_set_up", "Holli Bot's AI isn't set up on its server yet.");
  // A token Convex can't verify (expired, or not one of its own) throws here:
  // that's "not signed in" too, so the app renews its session and asks again.
  let userId: Awaited<ReturnType<typeof getAuthUserId>> = null;
  let sessionId: Awaited<ReturnType<typeof getAuthSessionId>> = null;
  try {
    userId = await getAuthUserId(ctx);
    sessionId = await getAuthSessionId(ctx);
  } catch { /* below */ }
  if (!userId || !sessionId) return refuse(401, "not_signed_in", "Sign in to Holli Bot to use its AI.");

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "bad_request", "That request isn't JSON.");
  }
  const asked = String(body?.model ?? "");
  const model = RENAMED[asked] ?? asked;
  if (!MODELS.includes(model)) return refuse(400, "bad_model", `Holli Bot's AI runs DeepSeek V4.1 Flash and V4 Pro, not ${asked || "that model"}.`);

  const stream = body.stream === true;
  const out: Record<string, unknown> = { model };
  for (const name of PASSED) if (body[name] !== undefined) out[name] = body[name];
  out.max_tokens = Math.min(MAX_TOKENS, Math.max(1, Math.floor(Number(body.max_tokens) || DEFAULT_TOKENS)));
  if (stream) Object.assign(out, { stream: true, stream_options: { include_usage: true } });

  // Held back while it runs: the most it could cost (all its input new to
  // DeepSeek, and all the output it may ask for).
  const prompt = promptTokens(out);
  const hold = costOf(model, { cached: 0, fresh: prompt, output: out.max_tokens as number }, Date.now());
  let admitted;
  try {
    admitted = await ctx.runMutation(internal.credits.admit, { userId, sessionId, hold });
  } catch (err) {
    console.error(`Letting ${userId}'s request in failed: ${err instanceof Error ? err.message : err}`);
    return refuse(503, "unavailable", "Holli Bot's AI couldn't take that request. Try again in a moment.");
  }
  if (!admitted.ok) return refuse(admitted.status, admitted.code, admitted.message);
  const { held } = admitted;
  const charge = (used: Usage | null, output = 0) =>
    ctx.runMutation(internal.credits.charge, {
      userId,
      model,
      at: Date.now(),
      held,
      ...(used ? { usage: used } : { estimate: { prompt, output } }),
    }).catch((err) => console.error(`Charging ${userId} for a request failed: ${err instanceof Error ? err.message : err}`));

  let upstream: Response;
  try {
    upstream = await fetch(`${DEEPSEEK}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(out),
    });
  } catch {
    await charge({ cached: 0, fresh: 0, output: 0 });
    return refuse(502, "unavailable", "Couldn't reach DeepSeek. Try again in a moment.");
  }
  if (!upstream.ok || !upstream.body) {
    await charge({ cached: 0, fresh: 0, output: 0 });
    return await fromDeepSeek(upstream);
  }

  if (!stream) {
    const data = await upstream.json().catch(() => null);
    await charge(usageOf(data?.usage));
    return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // The answer goes back to the app as DeepSeek sends it. Its last event says
  // what the request used; that's charged before the stream ends. If the app
  // goes away first, DeepSeek is stopped too, and what was sent is estimated.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const source = upstream.body;
  const pump = async () => {
    const writer = writable.getWriter();
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let used: Usage | null = null;
    let outputChars = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        try {
          await writer.write(value);
        } catch {
          await reader.cancel().catch(() => {});
          break;
        }
        pending += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            used = usageOf(event.usage) ?? used;
            const delta = event.choices?.[0]?.delta;
            if (delta) {
              outputChars += String(delta.content ?? "").length + String(delta.reasoning_content ?? "").length;
              if (delta.tool_calls) outputChars += JSON.stringify(delta.tool_calls).length;
            }
          } catch { /* not JSON: it went on as it was */ }
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
