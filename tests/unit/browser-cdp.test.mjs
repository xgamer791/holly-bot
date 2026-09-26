// Drives a real Chromium through Holly Bot Computer's DevTools-protocol browser
// against a local test site. Skipped when no Chrome/Chromium is installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpBrowser, findChrome, normalizeUrl } from '../../computer/src/browser-cdp.mjs';

const chrome = findChrome() || ['/opt/pw-browsers/chromium'].find((p) => existsSync(p));
const skip = chrome ? false : 'no Chrome/Chromium installed';

const PAGES = {
  '/': `<!doctype html><title>Holly test</title>
    <h1>Holly test page</h1>
    <p>Welcome to the <b>test</b> page.</p>
    <a href="/two">Go to page two</a>
    <a href="/popup" target="_blank">Open popup</a>
    <label>Your name <input id="name"></label>
    <label for="color">Color</label><select id="color"><option>Red</option><option>Green</option><option>Blue</option></select>
    <label><input type="checkbox" id="sub"> Subscribe</label>
    <button onclick="document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value + '!'">Say hi</button>
    <button onclick="alert('Hello there'); document.getElementById('out').textContent = 'after alert'">Alert me</button>
    <button id="count" onclick="window.clicks = (window.clicks || 0) + 1" style="position:absolute;left:100px;top:600px;width:120px;height:40px">Count</button>
    <div style="position:relative;height:40px"><button>Hidden button</button><div id="overlay" style="position:absolute;inset:0;background:#fff">Cookie banner</div></div>
    <div role="button" tabindex="0" onclick="document.getElementById('out').textContent='div clicked'">Fancy div button</div>
    <form action="/search"><input name="q" placeholder="Search the site"></form>
    <p id="out">nothing yet</p>`,
  '/two': '<!doctype html><title>Two</title><h1>Page two</h1><a href="/">Home</a>',
  '/popup': '<!doctype html><title>Popup</title><h1>Popup page</h1>',
};

let server;
let base;
let dir;
let browser;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/search') res.end(`<!doctype html><title>Search</title><h1>Results for ${url.searchParams.get('q')}</h1>`);
    else res.end(PAGES[url.pathname] || '<h1>Not found</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'holly-cdp-'));
  browser = new CdpBrowser({ executablePath: chrome, userDataDir: join(dir, 'profile'), downloadDir: join(dir, 'dl'), headless: true, log: { warn() {} } });
});

after(async () => {
  await browser?.close();
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const refFor = (text, pattern) => text.match(pattern)?.[1];

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('https://a.b/c'), 'https://a.b/c');
  assert.match(normalizeUrl('best pizza near me'), /^https:\/\/duckduckgo\.com\/\?q=best%20pizza/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
});

test('reads a page as text with element refs', { skip }, async () => {
  const r = await browser.goto(`${base}/`);
  assert.equal(r.title, 'Holly test');
  assert.match(r.text, /# Holly test page/);
  assert.match(r.text, /Welcome to the test page\./);
  assert.match(r.text, /\[e\d+\] link "Go to page two" → \/two/);
  assert.match(r.text, /\[e\d+\] link "Open popup" → \/popup \(opens a new tab\)/);
  assert.match(r.text, /\[e\d+\] textbox "Your name"/);
  assert.match(r.text, /\[e\d+\] select "Color" = "Red" options: Red \| Green \| Blue/);
  assert.match(r.text, /\[e\d+\] checkbox "Subscribe" \(not checked\)/);
  assert.match(r.text, /\[e\d+\] button "Fancy div button"/);
  assert.match(r.text, /textbox "Search the site"/);
});

test('types, picks options, ticks boxes and clicks buttons', { skip }, async () => {
  let r = await browser.snapshot();
  const name = refFor(r.text, /\[(e\d+)\] textbox "Your name"/);
  r = await browser.type({ ref: name, text: 'Ada' });
  assert.match(r.text, /textbox "Your name" = "Ada"/);
  r = await browser.type({ ref: name, text: 'Ada Lovelace' });
  assert.match(r.text, /textbox "Your name" = "Ada Lovelace"/, 'clears before typing');

  const color = refFor(r.text, /\[(e\d+)\] select "Color"/);
  r = await browser.type({ ref: color, text: 'green' });
  assert.match(r.note, /Picked “Green”/);
  assert.match(r.text, /select "Color" = "Green"/);

  const sub = refFor(r.text, /\[(e\d+)\] checkbox "Subscribe"/);
  r = await browser.click({ ref: sub });
  assert.match(r.text, /checkbox "Subscribe" \(checked\)/);

  r = await browser.click({ text: 'Say hi' });
  assert.match(r.text, /Hi Ada Lovelace!/);

  r = await browser.click({ text: 'Fancy div button' });
  assert.match(r.text, /div clicked/);
});

test('dialogs are answered and reported; covered elements are refused', { skip }, async () => {
  let r = await browser.click({ text: 'Alert me' });
  assert.match(r.note, /alert dialog: “Hello there”/);
  assert.match(r.text, /after alert/);
  await assert.rejects(browser.click({ text: 'Hidden button' }), /on top of it/);
  r = await browser.snapshot();
  await assert.rejects(browser.click({ ref: 'e99999' }), /no \[e99999\]/);
});

test('submits forms, goes back, follows new tabs', { skip }, async () => {
  let r = await browser.snapshot();
  const q = refFor(r.text, /\[(e\d+)\] textbox "Search the site"/);
  r = await browser.type({ ref: q, text: 'holly', submit: true });
  assert.match(r.url, /\/search\?q=holly/);
  assert.match(r.text, /Results for holly/);
  r = await browser.back();
  assert.match(r.text, /Holly test page/);
  r = await browser.click({ text: 'Open popup' });
  assert.match(r.note || '', /opened a new tab/);
  assert.match(r.text, /Popup page/);
  const tabs = await browser.listTabs();
  assert.equal(tabs.length, 2);
  assert.equal(tabs.filter((t) => t.active).length, 1);
});

test('each bot gets its own tab', { skip }, async () => {
  const a = await browser.goto(`${base}/two`, { owner: 'bot-a' });
  assert.match(a.text, /Page two/);
  const b = await browser.goto(`${base}/`, { owner: 'bot-b' });
  assert.match(b.text, /Holly test page/);
  assert.notEqual(a.tab, b.tab);
  const again = await browser.snapshot({ owner: 'bot-a' });
  assert.equal(again.tab, a.tab);
  assert.match(again.text, /Page two/);
  // The user (phone) can open any bot's tab by id.
  const peek = await browser.snapshot({ tab: b.tab });
  assert.match(peek.text, /Holly test page/);
  const closed = await browser.closeTab(a.tab, { owner: 'bot-a' });
  assert.ok(!closed.tabs.some((t) => t.id === a.tab));
});

test('screenshots and clicking by picture coordinates', { skip }, async () => {
  const o = { owner: 'bot-b' };
  const shot = await browser.screenshot({ maxWidth: 640 }, o);
  assert.ok(shot.width <= 640 && shot.width > 300, `width ${shot.width}`);
  assert.ok(Buffer.from(shot.data, 'base64')[0] === 0xff, 'jpeg');
  const box = await browser.evaluate('(() => { const r = document.getElementById("count").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, innerWidth]; })()', o);
  const s = shot.width / box[2];
  await browser.clickXY(box[0] * s, box[1] * s, o);
  assert.equal(await browser.evaluate('window.clicks', o), 1);
  await browser.press('Tab', o);
  const r = await browser.scroll({ direction: 'down' }, o);
  assert.ok(r.url.startsWith(base));
});

test('a restarted Holly Bot Computer reuses the running browser', { skip }, async () => {
  const again = new CdpBrowser({ executablePath: chrome, userDataDir: join(dir, 'profile'), headless: true });
  await again.start();
  assert.equal(again.proc, null, 'no second browser process');
  const tabs = await again.listTabs();
  assert.ok(tabs.length >= 1);
  again.cdp.close();
});
