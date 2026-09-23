// Integration: boots Holly Computer (bots living on the computer) and drives it
// through the same HTTP API the phone app uses, with a fake OpenAI-compatible
// model server standing in for DeepSeek.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../computer/src/main.mjs';
import { EventHub } from '../../computer/src/server.mjs';

let holly;
let modelServer;
let modelUrl;
let dir;
const requests = [];

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'holly-computer-'));
  modelServer = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, body: json });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-flash' }] }));
      return;
    }
    const sys = json.messages?.[0]?.content || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (/long-term memory of/.test(sys)) {
      res.end(chunk({ content: '{"operations":[]}' }, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    const last = json.messages[json.messages.length - 1];
    if (last.role === 'tool') {
      res.end(chunk({ reasoning_content: 'Done thinking.' }) + chunk({ content: `The command printed: ${last.content.match(/stdout:\n(.*)/)?.[1]}` }, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    if (/run echo/i.test(JSON.stringify(last.content))) {
      res.end(
        chunk({ reasoning_content: 'I should run it.' })
        + chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo holly-works"}' } }] }, 'tool_calls')
        + 'data: [DONE]\n\n',
      );
      return;
    }
    res.end(chunk({ content: 'Hi from the computer!' }, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise((r) => modelServer.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  holly = await main(['--port', '0', '--data', join(dir, 'data'), '--workspace', join(dir, 'ws'), '--no-open']);
});

after(async () => {
  holly?.app.stopScheduler();
  holly?.server.close();
  await holly?.computer.close();
  modelServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${holly.server.address().port}`;
const auth = () => ({ Authorization: `Bearer ${holly.token}`, 'Content-Type': 'application/json' });
async function rpc(method, ...args) {
  const res = await fetch(`${base()}/api/rpc`, { method: 'POST', headers: auth(), body: JSON.stringify({ method, args }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.result;
}

test('health is public, everything else needs the pairing token', async () => {
  const h = await (await fetch(`${base()}/v1/health`)).json();
  assert.equal(h.ok, true);
  assert.equal((await fetch(`${base()}/api/state`)).status, 401);
  const state = await (await fetch(`${base()}/api/state`, { headers: auth() })).json();
  assert.ok(Array.isArray(state.agents));
  assert.equal(state.computer.capabilities.shell, true);
});

test('shell and files on the computer', async () => {
  const res = await fetch(`${base()}/v1/exec`, { method: 'POST', headers: auth(), body: JSON.stringify({ command: 'echo hello-from-shell' }) });
  const quick = await res.json();
  assert.match(quick.chunks.map((c) => c.data).join(''), /hello-from-shell/);
  assert.equal(quick.done.code, 0);
  // Long commands: output is collected in pieces.
  const slow = await (await fetch(`${base()}/v1/exec`, { method: 'POST', headers: auth(), body: JSON.stringify({ command: 'echo one && sleep 1 && echo two' }) })).json();
  let out = slow.chunks.map((c) => c.data).join('');
  let cur = slow;
  while (!cur.done) {
    cur = await (await fetch(`${base()}/v1/jobs/${cur.job}?since=${cur.next}`, { headers: auth() })).json();
    out += cur.chunks.map((c) => c.data).join('');
  }
  assert.match(out, /one\s+two/);
  const w = await (await fetch(`${base()}/v1/fs/write`, { method: 'POST', headers: auth(), body: JSON.stringify({ path: 'notes/a.txt', text: 'hi' }) })).json();
  assert.equal(w.size, 2);
  const r = await (await fetch(`${base()}/v1/fs/read`, { method: 'POST', headers: auth(), body: JSON.stringify({ path: 'notes/a.txt' }) })).json();
  assert.equal(r.text, 'hi');
});

test('phone creates a bot, chats, bot runs a shell command on the computer; events stream back', async () => {
  await rpc('settings.save', { providers: { custom: { baseURL: modelUrl, apiKey: 'test', noKey: true } }, defaults: { provider: 'custom', model: 'fake-flash', memoryModel: 'same' }, autoReview: false });
  const events = [];
  const state = await (await fetch(`${base()}/api/state`, { headers: auth() })).json();
  let since = state.seq;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const r = await (await fetch(`${base()}/api/poll?since=${since}&boot=${state.boot}&client=test`, { headers: auth() })).json();
      assert.ok(!r.reset, 'no reset needed');
      events.push(...r.events);
      since = r.seq;
    }
  })();
  const agent = await rpc('agents.create', { name: 'Holly', greet: false });
  const threadId = `dm_${agent.id}`;
  await rpc('runtime.send', threadId, { text: 'Please run echo for me' });
  let msgs = [];
  for (let i = 0; i < 100; i++) {
    msgs = await rpc('messages.list', threadId);
    const last = msgs[msgs.length - 1];
    if (last?.authorType === 'agent' && last.status === 'done') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const reply = msgs[msgs.length - 1];
  assert.equal(reply.status, 'done', JSON.stringify(reply));
  assert.equal(reply.steps[0].toolCalls[0].name, 'shell');
  assert.match(reply.steps[0].toolCalls[0].result.content, /holly-works/);
  assert.equal(reply.steps[1].text, 'The command printed: holly-works');
  assert.equal(reply.steps[0].raw.provider, 'openai-chat', 'reasoning kept for replay');
  await new Promise((r) => setTimeout(r, 300));
  polling = false;
  await rpc('agents.update', agent.id, { bio: 'wake the poller' });
  await poller;
  assert.ok(events.some((e) => e.topic === 'agents'), 'agents event streamed');
  assert.ok(events.some((e) => e.topic === `messages:${threadId}` && e.data?.authorType === 'agent'), 'message updates streamed');
  assert.ok(events.some((e) => e.topic === 'runs'), 'run status streamed');
});

test('API keys never leave the computer', async () => {
  await rpc('settings.save', { providers: { deepseek: { apiKey: 'sk-secret-1234' } } });
  const state = await (await fetch(`${base()}/api/state`, { headers: auth() })).json();
  assert.equal(state.settings.providers.deepseek.apiKey, '••••1234');
  assert.ok(state.providersReady.includes('deepseek'));
  // Saving the masked value back must not overwrite the real key.
  await rpc('settings.save', { providers: { ...state.settings.providers } });
  assert.equal(holly.app.settings.providers.deepseek.apiKey, 'sk-secret-1234');
});

test('long polls: batching, coalescing and resets', async () => {
  const hub = new EventHub((topic, payload) => payload, { max: 5 });
  hub.push('messages:t1', { id: 'm1', text: 'a' });
  hub.push('messages:t1', { id: 'm1', text: 'ab' });
  hub.push('activity', { n: 1 });
  let r = hub.read(0, hub.boot);
  assert.deepEqual(r.events.map((e) => e.data), [{ id: 'm1', text: 'ab' }, { n: 1 }], 'message updates coalesce to the latest');
  assert.equal(hub.read(r.seq, hub.boot).events.length, 0);
  assert.equal(hub.read(r.seq, 'other-boot').reset, true, 'server restarted');
  for (let i = 0; i < 10; i++) hub.push('activity', { n: i });
  assert.equal(hub.read(r.seq, hub.boot).reset, true, 'fell too far behind');
  r = hub.read(hub.seq - 2, hub.boot);
  assert.equal(r.events.length, 2);
});
