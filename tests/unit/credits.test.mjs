// Bots on Holly Bot's AI (src/core/providers/index.js): requests go to the
// backend's /ai route with the account's session, renewed once when turned
// down; its refusals (credits used up) read as it says them; only DeepSeek's
// models; and a saved DeepSeek key until the server can run the AI.
// node --test tests/unit/credits.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderHub, AI_MODELS } from '../../src/core/providers/index.js';
import { AI_URL } from '../../src/account/config.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** The app, as the provider hub sees it: its settings, credits and account storage. */
function appWith({ ready = true, sessions = ['jwt-1', 'jwt-2'], savedKey = '' } = {}) {
  const asked = [];
  return {
    asked,
    settings: { providers: savedKey ? { deepseek: { apiKey: savedKey } } : {}, defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same' } },
    credits: { ready, allowance: 10_000_000, balance: 10_000_000, refillsAt: Date.now() + 86_400_000 },
    db: {
      cloud: true,
      async sessionToken({ force = false } = {}) {
        asked.push(force);
        return sessions[force ? 1 : 0];
      },
    },
    recordUsage() {},
  };
}

/** Stands in for the network: `answer` gets each request; all are kept. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return answer(call, calls.length);
  };
  return calls;
}

const sse = (events) => new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const hello = () => sse([
  { choices: [{ index: 0, delta: { content: 'Hello' } }] },
  { choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 } },
]);
const ask = (hub, agent = null) => hub.chat({ cfg: hub.resolve(agent), system: 'You are Holly.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], tools: [] });

test('a bot asks Holly Bot\'s AI with the account\'s session, and gets the answer streamed', async () => {
  const hub = new ProviderHub(appWith());
  const calls = stubFetch(() => hello());
  const res = await ask(hub);
  assert.equal(res.text, 'Hello there');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${AI_URL}/chat/completions`);
  assert.equal(AI_URL, 'https://impressive-ferret-800.convex.site/ai');
  assert.equal(calls[0].headers.Authorization, 'Bearer jwt-1');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.stream, true);
});

test('a session the server turns down is renewed once, and the request asked again', async () => {
  const app = appWith();
  const hub = new ProviderHub(app);
  const calls = stubFetch((call, n) => (n === 1
    ? new Response(JSON.stringify({ error: { message: 'Sign in to Holly Bot to use its AI.', type: 'holly_bot', code: 'not_signed_in' } }), { status: 401 })
    : hello()));
  const res = await ask(hub);
  assert.equal(res.text, 'Hello there');
  assert.deepEqual(app.asked, [false, true]);
  assert.equal(calls[1].headers.Authorization, 'Bearer jwt-2');
});

test('out of credits: the bot says so in the server\'s words, and isn\'t asked again', async () => {
  const hub = new ProviderHub(appWith());
  const message = 'Your AI credits for this month are used up. Your bots pause until they refill, in 3 days.';
  const calls = stubFetch(() => new Response(JSON.stringify({ error: { message, type: 'holly_bot', code: 'no_credits' } }), { status: 402 }));
  await assert.rejects(ask(hub), (err) => {
    assert.equal(err.message, message);
    assert.equal(err.code, 'no_credits');
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(hub.backupFor(hub.resolve(null), { status: 402 }), null);
});

test('only DeepSeek V4.1 Flash and V4 Pro: a bot set up on another model runs on Flash', () => {
  const hub = new ProviderHub(appWith());
  assert.deepEqual(AI_MODELS, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(hub.resolve({ provider: 'xai', model: 'grok-4' }).model, 'deepseek-flash');
  assert.equal(hub.resolve({ provider: 'deepseek', model: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  assert.equal(hub.resolve({ memoryModel: 'deepseek:deepseek-flash', model: 'deepseek-v4-pro' }, 'memory').model, 'deepseek-flash');
  assert.deepEqual(hub.readyProviders(), ['deepseek']);
  assert.equal(hub.isReady('openai'), false);
  assert.equal(hub.imageProvider(), null);
  assert.equal(hub.embedder(), null);
});

test('until the server can run the AI, a saved DeepSeek key still works; without one, bots wait', async () => {
  const hub = new ProviderHub(appWith({ ready: false, savedKey: 'sk-mine' }));
  const calls = stubFetch(() => hello());
  const res = await ask(hub);
  assert.equal(res.text, 'Hello there');
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-mine');

  const waiting = new ProviderHub(appWith({ ready: false }));
  assert.throws(() => waiting.resolve(null), (err) => err.kind === 'no_key' && /isn't ready yet/.test(err.message));
});
