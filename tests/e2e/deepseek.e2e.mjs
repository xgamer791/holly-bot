// End-to-end on the main provider: DeepSeek V4.1 Flash (OpenAI-style chat
// completions with thinking). A scripted fake api.deepseek.com checks what the
// app sends — including reasoning_content replay after tool calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const PORT = Number(process.env.E2E_PORT || 8767);
const BASE = `http://localhost:${PORT}/?nosw`;
const SHOTS = process.env.SHOTS_DIR || new URL('../../test-results/shots', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let server;
let browser;
let page;
const errors = [];
const requests = [];
const shot = (name) => page.screenshot({ path: `${SHOTS}/ds-${name}.png` });
const chat = () => page.locator('.pane-chat');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function closeSheets() {
  for (let i = 0; i < 6 && (await page.locator('.sheet').count()); i++) {
    const back = page.locator('.sheet').last().getByRole('button', { name: 'Back', exact: true }).first();
    if (await back.count()) await back.click();
    else await page.locator('.sheet').last().getByRole('button', { name: 'Close', exact: true }).first().click();
    await sleep(350);
  }
}

function chunks(deltas, finish = 'stop') {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ id: 'x', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ id: 'x', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ id: 'x', model: 'deepseek-flash', choices: [], usage: { prompt_tokens: 3000, completion_tokens: 80, prompt_cache_hit_tokens: 2500 } })}\n\n`);
  return `${lines.join('')}data: [DONE]\n\n`;
}

const reply = (thought, text) => chunks([{ reasoning_content: thought }, ...text.match(/.{1,10}/gs).map((content) => ({ content }))]);

async function answer(body) {
  const system = body.messages[0]?.content || '';
  if (/long-term memory of|compress conversation|reflect on what it knows|"human" core-memory/.test(system)) return chunks([{ content: '{"operations":[]}' }]);
  const last = body.messages[body.messages.length - 1];
  const lastText = typeof last.content === 'string' ? last.content : (last.content || []).map((c) => c.text || '').join('');
  if (last.role === 'tool') return reply('Saved. Now confirm briefly.', 'Saved — I’ll remember that teal is your favorite color.');
  if (/remember/i.test(lastText)) {
    return chunks([
      { reasoning_content: 'The user wants me to save a preference.' },
      { tool_calls: [{ index: 0, id: 'call_mem', type: 'function', function: { name: 'remember', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"text":"Favorite color: teal","type":"preference","importance":6}' } }] },
    ], 'tool_calls');
  }
  await sleep(1500); // long enough to see the bot's thinking animation
  return reply('A friendly greeting fits.', 'Hello from DeepSeek!');
}

before(async () => {
  process.argv[2] = String(PORT);
  server = (await import('../../scripts/serve.mjs')).default;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' };
  await page.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname;
    if (path === '/models') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) });
    if (path === '/user/balance') {
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }] }) });
    }
    const body = JSON.parse(req.postData() || '{}');
    requests.push(body);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: await answer(body) });
  });
  await page.goto(BASE);
  await page.waitForSelector('.pane-list');
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('add a DeepSeek key', async () => {
  await page.getByRole('button', { name: 'Add API key' }).click();
  await page.getByText('DeepSeek', { exact: true }).first().click();
  await page.getByPlaceholder('sk-…').fill('sk-deepseek-test');
  await page.getByRole('button', { name: 'Save & test connection' }).click();
  await page.getByText(/Connected — 2 models available/).waitFor();
  await page.getByRole('button', { name: 'Back' }).click();
  assert.equal(await page.getByLabel('Backup model').count(), 1, 'backup setting is offered');
  await shot('keys');
  await closeSheets();
});

test('new bot thinks with its own animation, then answers with DeepSeek Flash', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Bot' }).click();
  await page.getByLabel('Bot name').fill('Ada');
  await page.getByRole('radio', { name: 'Blob' }).click();
  await page.getByRole('radio', { name: 'teal' }).click();
  await page.locator('.think-pick', { hasText: 'Orbit' }).click();
  await shot('create-thinking-picker');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await chat().getByText('What should I focus on first?').waitFor();
  await page.getByLabel('Ask Ada').fill('Hi Ada');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().locator('.avatar.is-working.think-orbit').first().waitFor();
  await shot('thinking');
  await chat().getByText('Hello from DeepSeek!').waitFor();
  const req = requests.find((r) => JSON.stringify(r.messages.at(-1)).includes('Hi Ada'));
  assert.equal(req.model, 'deepseek-flash');
  assert.deepEqual(req.thinking, { type: 'enabled' });
  assert.equal(req.stream, true);
  await chat().getByRole('button', { name: /Thoughts/ }).first().click();
  await chat().getByText('A friendly greeting fits.').waitFor();
  await shot('reply-with-thoughts');
});

test('tool calls replay reasoning_content on the next request', async () => {
  await page.getByLabel('Ask Ada').fill('Please remember that my favorite color is teal');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText('Saved — I’ll remember that teal is your favorite color.').waitFor();
  const followUp = requests.filter((r) => r.messages.at(-1).role === 'tool').at(-1);
  const assistant = followUp.messages.at(-2);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls[0].function.name, 'remember');
  assert.equal(assistant.reasoning_content, 'The user wants me to save a preference.');
  // Earlier assistant turns also carry reasoning_content (DeepSeek requires it with tools).
  for (const m of followUp.messages.filter((x) => x.role === 'assistant')) assert.equal(typeof m.reasoning_content, 'string');
  await shot('tool-call');
});

test('usage shows DeepSeek balance and spend', async () => {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Usage/ }).click();
  await page.getByText('$12.34').waitFor();
  await page.getByText(/deepseek-flash/).first().waitFor();
  await shot('usage');
  await closeSheets();
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
