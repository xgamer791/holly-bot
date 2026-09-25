// End-to-end: drives the real app in Chromium (iPhone viewport) against a
// scripted fake xAI API. Run with `npm run test:e2e`. Screenshots land in
// $SHOTS_DIR (default: test-results/shots).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';
import { mockXai, textResponse, toolResponse, webSearchResponse } from './mock-xai.mjs';

const PORT = Number(process.env.E2E_PORT || 8765);
const BASE = `http://localhost:${PORT}/?nosw`;
const SHOTS = process.env.SHOTS_DIR || new URL('../../test-results/shots', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let server;
let browser;
let page;
const errors = [];
const log = [];
let shotN = 0;
const chat = () => page.locator('.pane-chat');
const shot = (name) => page.screenshot({ path: `${SHOTS}/${String(++shotN).padStart(2, '0')}-${name}.png` });

function script(d) {
  if (/route messages in a group chat/.test(d.instructions)) return textResponse('{"speakers":["Holly","Nova"]}');
  if (d.isMemoryJob) {
    if (/long-term memory of/.test(d.instructions) && /Max/.test(JSON.stringify(d.input))) {
      return textResponse('{"operations":[{"op":"add","text":"User has a golden retriever named Max.","type":"fact","importance":7}]}');
    }
    return textResponse('{"operations":[]}');
  }
  if (d.me === 'Nova') {
    if (/## Group chat/.test(d.instructions)) return textResponse('Nova here — I agree with Holly. @Holly can you draft the plan?');
    if (/\[Holly\]:|Private channel/.test(d.lastUserText + d.instructions)) return textResponse('Short answer: ship the MVP first, then iterate on memory quality.');
    return textResponse('Hi, I am Nova.');
  }
  // Holly
  if (d.lastToolName === 'remember') return textResponse('Got it — I’ll remember Max. 🐶');
  if (d.lastToolName === 'message_agent') return textResponse(`Nova says: ${String(d.lastTool.output).split('\n').pop()}`);
  if (d.lastToolName === 'shell') return textResponse(d.lastTool.output.includes('denied') ? 'Okay, I won’t run it.' : 'Done.');
  if (d.lastToolName === 'ask_user') return textResponse(`Great choice: ${d.lastTool.output.replace('The user chose: ', '')}.`);
  if (d.lastUserText === 'Coding & projects') return textResponse('Love it. What are you building right now — and what’s blocking you?');
  if (/dog/i.test(d.lastUserText)) return toolResponse([{ name: 'remember', args: { text: 'User has a golden retriever named Max.', type: 'fact', importance: 7 } }]);
  if (/ask nova/i.test(d.lastUserText)) return toolResponse([{ name: 'message_agent', args: { agent: 'Nova', message: 'Should we ship the MVP or polish memory first?' } }]);
  if (/pick a stack/i.test(d.lastUserText)) {
    return toolResponse([{ name: 'ask_user', args: { question: 'Which stack should we use?', subtitle: 'Pick one — we can change later.', options: ['Next.js', 'SvelteKit', 'Plain HTML'] } }]);
  }
  if (/news/i.test(d.lastUserText)) {
    return webSearchResponse('latest AI news', 'Here’s the latest: new open models shipped this week [1].', [{ url: 'https://example.com/ai-news', title: 'AI news roundup' }]);
  }
  if (/## Group chat/.test(d.instructions)) return textResponse('Holly here: plan is 1) scope 2) build 3) test.');
  return textResponse('Hey! How can I help?');
}

before(async () => {
  process.argv[2] = String(PORT);
  server = (await import('../../scripts/serve.mjs')).default;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await mockXai(page, script, log);
  await page.goto(BASE);
  await page.waitForSelector('.pane-list');
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('add an xAI key in Settings and test it', async () => {
  await shot('home-empty');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Your profile').click();
  await page.getByPlaceholder('Your name').fill('Sam Rivera');
  await page.getByPlaceholder('Your name').blur();
  await page.getByRole('button', { name: 'Back' }).click();
  await shot('settings-main');
  await page.getByRole('button', { name: /^API Keys/ }).click();
  await page.getByText('xAI (Grok)').click();
  await page.getByPlaceholder('xai-…').fill('xai-test-key');
  await page.getByRole('button', { name: 'Save & test connection' }).click();
  await page.getByText(/Connected — \d+ models available/).waitFor();
  await shot('settings-xai-key');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
});

test('create a bot: name, shape, color → greeting with focus card', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await shot('plus-menu');
  await page.getByRole('menuitem', { name: 'New Bot' }).click();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  assert.equal(await create.isDisabled(), true, 'Create disabled until named');
  await page.getByLabel('Bot name').fill('Holly');
  await page.getByRole('radio', { name: 'Cloud' }).click();
  await page.getByRole('radio', { name: 'white' }).click();
  await shot('create-bot');
  await create.click();
  await chat().getByText('What should I focus on first?').waitFor();
  await page.waitForTimeout(300);
  await shot('chat-greeting');
});

test('answering the focus card starts the conversation', async () => {
  await page.getByRole('button', { name: /Coding & projects/ }).click();
  await chat().getByText('Love it. What are you building').waitFor();
  await shot('chat-after-focus');
});

test('memory: the bot saves a fact with a tool and it shows in Memories', async () => {
  const box = page.getByLabel('Ask Holly');
  await box.fill('My dog is a golden retriever called Max');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText('Got it — I’ll remember Max.').waitFor();
  await chat().getByText(/Saved to memory/).first().waitFor();
  await shot('chat-memory-saved');
  await page.getByRole('button', { name: 'Holly settings' }).click();
  await page.waitForTimeout(200);
  await shot('bot-profile');
  await page.getByText('Memories', { exact: true }).click();
  await page.getByText('User has a golden retriever named Max.').first().waitFor();
  await shot('memory-sheet');
  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('button', { name: 'Close' }).last().click();
});

test('ask_user question card from the model', async () => {
  await page.getByLabel('Ask Holly').fill('Help me pick a stack');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText('Which stack should we use?').waitFor();
  await shot('model-question-card');
  await page.getByRole('button', { name: /SvelteKit/ }).click();
  await chat().getByText('Great choice: SvelteKit.').waitFor();
});

test('web search results with sources (native xAI search)', async () => {
  await page.getByLabel('Ask Holly').fill('Any AI news today?');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText(/Here’s the latest/).waitFor();
  await chat().getByText(/Searched the web/).waitFor();
  await shot('web-search');
});

test('second bot, then Holly messages Nova (bot-to-bot)', async () => {
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Bot' }).click();
  await page.getByLabel('Bot name').fill('Nova');
  await page.getByRole('radio', { name: 'Blob' }).click();
  await page.getByRole('radio', { name: 'purple' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await chat().getByText('What should I focus on first?').waitFor();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /^Holly/ }).first().click();
  await page.getByLabel('Ask Holly').fill('Ask Nova whether we should ship now');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText(/Nova says: Short answer/).waitFor();
  await shot('bot-to-bot');
  await page.getByRole('button', { name: 'View chat' }).click();
  await chat().getByText('Private channel between').waitFor();
  await shot('agent-channel');
  await page.getByRole('button', { name: 'Back' }).click();
});

test('home list shows both bots with previews', async () => {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(400);
  await shot('home-list');
  const titles = await page.locator('.row-bot .title').allTextContents();
  assert.ok(titles.includes('Holly') && titles.includes('Nova'), `home list: ${titles}`);
});

test('group chat with both bots', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Group Chat' }).click();
  await page.getByRole('button', { name: /Holly/ }).last().click();
  await page.getByRole('button', { name: /Nova/ }).last().click();
  await page.getByPlaceholder(/Launch team|Holly, Nova/).fill('Launch Team');
  await shot('new-group');
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.getByLabel('Message Launch Team').fill('What is our plan for launch?');
  await page.getByRole('button', { name: 'Send' }).click();
  await chat().getByText(/Holly here: plan is/).waitFor();
  await chat().getByText(/Nova here — I agree/).waitFor();
  await page.waitForTimeout(500);
  await shot('group-chat');
});

test('computer panel opens', async () => {
  await page.getByRole('button', { name: 'Bot computer' }).click();
  await page.waitForTimeout(200);
  await shot('computer-panel');
  await page.getByRole('button', { name: 'Close' }).last().click();
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
