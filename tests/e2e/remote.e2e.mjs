// End to end, the way Holly is meant to be used: bots live on the computer
// (Holly Computer) and the phone is the remote control. A fake OpenAI-style
// model server stands in for the provider; the phone is Chromium at iPhone size.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { main } from '../../computer/src/main.mjs';

const SHOTS = process.env.SHOTS_DIR || new URL('../../test-results/shots', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const PORT = 8790 + Math.floor(Math.random() * 100);

let dir;
let holly;
let modelServer;
let browser;
let page;
const errors = [];
const shot = (name) => page.screenshot({ path: `${SHOTS}/remote-${name}.png` });
const chat = () => page.locator('.pane-chat');

function sse(deltas, finish = 'stop') {
  return `${deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join('')}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
}

async function startHolly() {
  holly = await main(['--port', String(PORT), '--data', join(dir, 'data'), '--workspace', join(dir, 'ws'), '--no-open', '--no-tunnel']);
}

async function stopHolly() {
  holly.app.stopScheduler();
  holly.server.close();
  holly.server.closeAllConnections?.();
  await holly.computer.close();
  holly.db.close();
}

async function rpc(method, ...args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${holly.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  return (await res.json()).result;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'holly-remote-e2e-'));
  modelServer = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-flash' }] }));
      return;
    }
    const json = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const system = json.messages?.[0]?.content || '';
    const last = json.messages.at(-1);
    if (/long-term memory of|compress conversation|reflect on what it knows|"human" core-memory/.test(system)) return res.end(sse([{ content: '{"operations":[]}' }]));
    if (last.role === 'tool') return res.end(sse([{ reasoning_content: 'It worked.' }, { content: `Done! The computer says: ${last.content.match(/stdout:\n(.*)/)?.[1]}` }]));
    // What the user typed (every message also carries a reminder for the bot, which mentions the computer).
    if (/Use the computer/.test(JSON.stringify(last.content))) {
      await new Promise((r) => setTimeout(r, 800));
      return res.end(sse([
        { reasoning_content: 'I will use the shell.' },
        { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo hello-from-your-computer"}' } }] },
      ], 'tool_calls'));
    }
    return res.end(sse([{ content: 'Hi! I live on your computer.' }]));
  });
  await new Promise((r) => modelServer.listen(0, '127.0.0.1', r));
  await startHolly();
  // Holly Bot's AI on a saved DeepSeek key, pointed at the stand-in model.
  await rpc('settings.save', {
    providers: { deepseek: { baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, apiKey: 'test' } },
    defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same' },
    askFirst: false,
    profile: { name: 'Sam', email: '', about: '' },
  });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US', serviceWorkers: 'block' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_CONNECTION_REFUSED|Can't reach/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
});

after(async () => {
  await browser?.close();
  if (holly) await stopHolly().catch(() => {});
  modelServer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the pairing link opens the app in remote-control mode', async () => {
  const link = `http://localhost:${PORT}/?nosw#connect=${Buffer.from(JSON.stringify({ url: '', token: holly.token })).toString('base64url')}`;
  await page.goto(link);
  await page.waitForSelector('.pane-list');
  await page.getByRole('button', { name: 'New Bot' }).first().waitFor();
  assert.equal(await page.locator('.computer-cta').count(), 0, 'no "set up your computer" prompt when already on it');
  await shot('home');
});

test('create a bot from the phone; it lives on the computer', async () => {
  await page.getByRole('button', { name: 'New Bot' }).first().click();
  await page.getByLabel('Bot name').fill('Holly');
  await page.getByRole('radio', { name: 'Cloud' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await chat().getByText('What should I focus on first?').waitFor();
  assert.ok(holly.app.listAgents().some((a) => a.name === 'Holly'), 'bot stored on the computer');
});

test('the bot uses the computer; the phone sees it live', async () => {
  await page.getByLabel('Ask Holly').fill('Use the computer to say hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText('Done! The computer says: hello-from-your-computer').waitFor();
  // The chat shows the outcome, not the steps (1.12): the shell ran on the computer.
  const agent = holly.app.listAgents().find((a) => a.name === 'Holly');
  const reply = (await holly.app.loadMessages(`dm_${agent.id}`)).at(-1);
  assert.equal(reply.steps[0].toolCalls[0].name, 'shell');
  assert.match(reply.steps[0].toolCalls[0].result.content, /hello-from-your-computer/);
  await shot('chat');
});

test('the phone notices when the computer is unreachable and recovers after it restarts', async () => {
  await stopHolly();
  await page.waitForFunction(() => window.holly?.reachable === false, null, { timeout: 20000 });
  await shot('offline');
  await startHolly();
  await page.waitForFunction(() => window.holly?.reachable === true, null, { timeout: 30000 });
  // Still in sync after the restart: a new message arrives live.
  await page.getByLabel('Ask Holly').fill('Hello again');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText('Hi! I live on your computer.').waitFor();
  await shot('reconnected');
});

test('with the offline app cache on, live data still comes fresh from the computer', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US' });
  const phone = await ctx.newPage();
  const link = `http://localhost:${PORT}/#connect=${Buffer.from(JSON.stringify({ url: '', token: holly.token })).toString('base64url')}`;
  await phone.goto(link);
  await phone.waitForSelector('.pane-list');
  await phone.evaluate(() => navigator.serviceWorker.ready);
  await phone.reload();
  await phone.waitForSelector('.pane-list');
  assert.ok(await phone.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
  await rpc('agents.create', { name: 'Nova', greet: false });
  await phone.locator('.row-bot', { hasText: 'Nova' }).waitFor();
  await phone.reload();
  await phone.locator('.row-bot', { hasText: 'Nova' }).waitFor();
  const cached = await phone.evaluate(async () => {
    const keys = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) keys.push(new URL(r.url).pathname);
    return keys;
  });
  assert.ok(cached.some((p) => p.endsWith('/src/main.js')), 'app files are cached for offline use');
  assert.deepEqual(cached.filter((p) => /^\/(api|v1)\//.test(p)), [], 'API responses are never cached');
  await ctx.close();
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
