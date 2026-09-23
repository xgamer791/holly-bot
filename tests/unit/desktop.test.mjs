// End to end: a virtual X screen with a real Chromium window on it, driven only
// through Holly Computer's screen/mouse/keyboard actions (as a bot would).
// Linux only; skipped unless Xvfb, xdotool, ImageMagick and Chromium exist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which, parseKeys, windowsKeySpec } from '../../computer/src/desktop.mjs';
import { findChrome, CdpBrowser } from '../../computer/src/browser-cdp.mjs';
import { LocalComputer } from '../../computer/src/local-computer.mjs';

const chrome = findChrome() || ['/opt/pw-browsers/chromium'].find((p) => existsSync(p));
const ready = process.platform === 'linux' && which('Xvfb') && which('xdotool') && which('import') && chrome;
const skip = ready ? false : 'needs Linux with Xvfb, xdotool, ImageMagick and Chromium';

const PAGE = `<!doctype html><title>Desk</title>
<style>body{margin:0;font:16px sans-serif} #btn{position:absolute;left:200px;top:150px;width:200px;height:80px}
#field{position:absolute;left:200px;top:300px;width:300px;height:40px;font-size:20px} #tall{height:3000px}</style>
<button id="btn" onclick="window.clicks=(window.clicks||0)+1">Click me</button>
<input id="field">
<div id="tall"></div>
<script>
window.downs = []; window.ups = [];
addEventListener('mousedown', (e) => downs.push([e.clientX, e.clientY]));
addEventListener('mouseup', (e) => ups.push([e.clientX, e.clientY]));
</script>`;

let xvfb;
let server;
let dir;
let page;
let computer;
let savedDisplay;
let chromium;
let appTab;
const evaluate = (js) => page.evaluate(js, { tab: appTab });

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'holly-desk-'));
  const display = `:${150 + Math.floor(Math.random() * 100)}`;
  xvfb = spawn('Xvfb', [display, '-noreset', '-screen', '0', '1024x768x24'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = display;
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // A Chromium "app" window filling the virtual screen; we watch it over DevTools.
  const profile = join(dir, 'profile');
  chromium = spawn(chrome, [
    `--app=${url}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-position=0,0', '--window-size=1024,768', '--disable-gpu', '--force-device-scale-factor=1', '--no-sandbox',
  ], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
  for (let i = 0; i < 100 && !existsSync(join(profile, 'DevToolsActivePort')); i++) await new Promise((r) => setTimeout(r, 100));
  page = new CdpBrowser({ executablePath: chrome, userDataDir: profile });
  await page.start();
  for (let i = 0; i < 50 && !appTab; i++) {
    appTab = (await page.listTabs()).find((x) => x.url === url)?.id;
    if (!appTab) await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));
  computer = new LocalComputer({ workspace: join(dir, 'ws'), dataDir: join(dir, 'data'), log: { warn() {} } });
  await computer.connect();
});

after(async () => {
  await computer?.close();
  page?.cdp?.close();
  chromium?.kill();
  server?.close();
  xvfb?.kill();
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Screen position of the page's content area (Chrome draws its own title bar). */
async function contentOrigin() {
  const [sx, sy, ow, oh, iw, ih] = await evaluate('[screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight]');
  return { x: sx + Math.round((ow - iw) / 2), y: sy + (oh - ih) };
}

test('key names', () => {
  assert.deepEqual(parseKeys('ctrl+shift+t', 'linux'), [{ mods: ['ctrl', 'shift'], key: 't' }]);
  assert.deepEqual(parseKeys('cmd+c', 'linux'), [{ mods: ['ctrl'], key: 'c' }], 'cmd means ctrl off macOS');
  assert.deepEqual(parseKeys('win', 'darwin'), [{ mods: [], key: 'cmd' }]);
  assert.deepEqual(parseKeys('ctrl++ Return', 'linux'), [{ mods: ['ctrl'], key: '+' }, { mods: [], key: 'enter' }]);
  assert.equal(windowsKeySpec('ctrl+c alt+f4 win'), 'v17 v67|v18 v115|v91');
  assert.throws(() => parseKeys('ctrl+nonsense'), /Unknown key/);
});

test('sees the screen', { skip }, async () => {
  const info = computer.info;
  assert.equal(info.capabilities.screenshot, true);
  assert.equal(info.capabilities.desktop, true);
  assert.deepEqual(info.screen, { width: 1024, height: 768 });
  const r = await computer.desktopAction('screenshot');
  assert.equal(r.screenshot.width, 1024);
  assert.equal(r.screenshot.mime, 'image/jpeg');
  const small = await computer.desktopAction('screenshot', { maxWidth: 512 });
  assert.equal(small.screenshot.width, 512);
  assert.equal(small.screenshot.height, 384);
});

test('clicks, types and uses shortcuts in a real window', { skip }, async () => {
  const o = await contentOrigin();
  // Click the button's center, in screenshot pixels.
  await computer.desktopAction('click', { x: o.x + 300, y: o.y + 190 });
  assert.equal(await evaluate('window.clicks'), 1);
  // Same button through a half-size screenshot: coordinates are scaled up.
  await computer.desktopAction('click', { x: Math.round((o.x + 300) / 2), y: Math.round((o.y + 190) / 2), maxWidth: 512 });
  assert.equal(await evaluate('window.clicks'), 2);

  await computer.desktopAction('click', { x: o.x + 350, y: o.y + 320 });
  await computer.desktopAction('type', { text: 'hello desktop' });
  assert.equal(await evaluate('document.getElementById("field").value'), 'hello desktop');
  await computer.desktopAction('key', { keys: 'ctrl+a' });
  await computer.desktopAction('type', { text: 'X' });
  assert.equal(await evaluate('document.getElementById("field").value'), 'X');
  await computer.desktopAction('key', { keys: 'BackSpace' });
  assert.equal(await evaluate('document.getElementById("field").value'), '');
});

test('drags, scrolls and reports the cursor', { skip }, async () => {
  const o = await contentOrigin();
  await evaluate('downs.length = 0; ups.length = 0');
  await computer.desktopAction('drag', { x: o.x + 600, y: o.y + 100, to_x: o.x + 700, to_y: o.y + 200 });
  assert.deepEqual(await evaluate('downs[0]'), [600, 100]);
  assert.deepEqual(await evaluate('ups[0]'), [700, 200]);
  const c = await computer.desktopAction('cursor');
  assert.deepEqual(c.cursor, { x: o.x + 700, y: o.y + 200 });
  await computer.desktopAction('scroll', { x: o.x + 600, y: o.y + 400, direction: 'down', amount: 5 });
  assert.ok((await evaluate('scrollY')) > 0, 'page scrolled');
});
