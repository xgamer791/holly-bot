// In-process implementation of the Bot Computer interface (same methods as the
// browser's HTTP ComputerClient in src/core/computer.js). Holly Computer's bots
// call this directly; the HTTP API exposes it to phones and browsers.

import os from 'node:os';
import { join, resolve, isAbsolute, dirname, extname, basename } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile, appendFile, readdir, stat, rm } from 'node:fs/promises';
import { runCommand, startBackground, detectShell } from './shell.mjs';
import { fetchPage, webSearch } from './web.mjs';
import { McpHost } from './mcp-stdio.mjs';
import { BotScreens, SCREEN_SIZE } from './screens.mjs';
import { APP_VERSION } from '../../src/core/constants.js';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|svg|ya?ml|toml|ini|cfg|conf|log|sh|bash|zsh|ps1|psm1|bat|cmd|sql|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|lua|r|tex|env|gitignore|dockerfile)$/i;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/html', '.md': 'text/markdown', '.csv': 'text/csv', '.svg': 'image/svg+xml' };
const MAX_READ = 8 * 1024 * 1024;
const NO_BROWSER = 'No Chrome, Edge, Chromium or Brave found. Install Chrome, or set HOLLY_BROWSER to the browser executable path.';

export const VERSION = APP_VERSION;

export class LocalComputer {
  constructor({ workspace, dataDir, log = console, headlessBrowser = false, name } = {}) {
    this.workspace = workspace;
    this.dataDir = dataDir;
    this.log = log;
    this.headlessBrowser = headlessBrowser;
    this.name = name || os.hostname();
    this.connected = true;
    this.configured = true;
    this.error = '';
    this.info = null;
    this.desktopPromise = null;
    this.desktopQueues = new Map(); // '' for this computer's screen, 'bots' for the bots' own screens
    this.browserInstance = null;
    this.browserQueues = new Map();
    // On a server each bot gets a screen of its own (computer/src/screens.mjs),
    // with its own window of the one Chrome, so the logins are shared.
    /** Whether a bot is working (set by main.mjs), so it keeps its screen. */
    this.isBusy = () => false;
    this.screens = BotScreens.available()
      ? new BotScreens({ log, onFree: (owner) => this.letGo(owner), busy: (owner) => this.isBusy(owner) })
      : null;
    this.botDesktops = new Map(); // bot → { index, ready: Promise<desktop> }
    this.mcp = new McpHost({ configPath: join(dataDir, 'mcp.json'), log });
    mkdirSync(workspace, { recursive: true });
  }

  configure() { /* nothing to configure in-process */ }

  async start() {
    await this.mcp.start().catch((err) => this.log.warn?.(`plugins: ${err.message}`));
    await this.connect();
  }

  /** Whether `owner` (a bot's id) has a screen of its own here. */
  ownScreen(owner) {
    return !!this.screens && !!owner && owner !== 'user';
  }

  /** The screen's controls: a bot's own screen's, or this computer's. */
  async desktop(owner) {
    if (this.ownScreen(owner)) {
      const place = await this.screens.place(owner);
      let d = this.botDesktops.get(owner);
      if (!d || d.index !== place.index || d.display !== place.display) {
        d = { index: place.index, display: place.display, ready: import('./desktop.mjs').then((m) => m.createDesktop({ log: this.log, env: { ...process.env, DISPLAY: place.display }, region: place })) };
        this.botDesktops.set(owner, d);
      }
      return d.ready;
    }
    this.desktopPromise ||= import('./desktop.mjs').then((m) => m.createDesktop({ log: this.log })).catch((err) => {
      this.desktopPromise = null;
      throw err;
    });
    return this.desktopPromise;
  }

  /** The browser: one Chrome, where each bot has its tab, or with screens of
   * their own, its own window on its screen. */
  async browserApi() {
    if (this.browserInstance) return this.browserInstance;
    const { CdpBrowser, findChrome } = await import('./browser-cdp.mjs');
    const executablePath = findChrome();
    if (!executablePath) throw new Error(NO_BROWSER);
    const screens = this.screens;
    const display = screens ? await screens.display() : null;
    // No screen to show a window on (a server without one): run the browser headless.
    const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    this.browserInstance = new CdpBrowser({
      executablePath,
      userDataDir: join(this.dataDir, 'browser-profile'),
      downloadDir: join(this.workspace, 'Downloads'),
      headless: !display && (this.headlessBrowser || noDisplay),
      extraArgs: String(process.env.HOLLY_BROWSER_ARGS || '').split(/\s+/).filter(Boolean),
      log: this.log,
      ...(display ? {
        env: { ...process.env, DISPLAY: display },
        width: SCREEN_SIZE.width,
        height: SCREEN_SIZE.height,
        place: (owner) => screens.place(owner),
      } : {}),
    });
    return this.browserInstance;
  }

  /** A bot gave up its screen (BotScreens): its browser windows close. */
  letGo(owner) {
    this.browserInstance?.release(owner).catch(() => {});
    const d = this.botDesktops.get(owner);
    this.botDesktops.delete(owner);
    d?.ready.then((desk) => desk.close()).catch(() => {});
  }

  async connect() {
    let desktopInfo = null;
    try {
      desktopInfo = await (await this.desktop()).info();
    } catch (err) {
      desktopInfo = { screenshotAvailable: false, inputAvailable: false, notes: [err.message] };
    }
    let chrome = null;
    try {
      chrome = (await import('./browser-cdp.mjs')).findChrome();
    } catch { /* module missing */ }
    const shell = detectShell();
    this.info = {
      name: this.name,
      hostname: os.hostname(),
      os: `${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform} ${os.release()}`,
      platform: process.platform,
      arch: os.arch(),
      user: os.userInfo().username,
      shell: shell.name,
      home: os.homedir(),
      workspace: this.workspace,
      cwd: this.workspace,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      node: process.version,
      version: VERSION,
      screen: desktopInfo?.width ? { width: desktopInfo.width, height: desktopInfo.height } : null,
      notes: desktopInfo?.notes || [],
      capabilities: {
        shell: true,
        files: true,
        fetch: true,
        search: true,
        screenshot: !!desktopInfo?.screenshotAvailable,
        desktop: !!desktopInfo?.inputAvailable,
        browser: !!chrome,
        mcp: true,
        // Each bot has a screen of its own (and its own Chrome) rather than sharing this one.
        screens: !!this.screens,
      },
    };
    this.connected = true;
    return this.info;
  }

  resolvePath(p) {
    let path = String(p || '.').trim();
    if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = join(os.homedir(), path.slice(1));
    return isAbsolute(path) ? path : resolve(this.workspace, path);
  }

  // ----- shell ---------------------------------------------------------------

  async exec(command, { cwd, timeoutMs = 120000, onData, signal, background = false } = {}) {
    const dir = cwd ? this.resolvePath(cwd) : this.workspace;
    if (background) {
      const job = startBackground(command, { cwd: dir, logDir: join(this.dataDir, 'jobs') });
      return { stdout: `Started in background (pid ${job.pid}). Output is written to ${job.logFile}`, stderr: '', code: 0, cwd: dir, pid: job.pid, logFile: job.logFile };
    }
    return runCommand(command, { cwd: dir, timeoutMs, onData, signal });
  }

  // ----- files -----------------------------------------------------------------

  async fs(op, args = {}) {
    const path = this.resolvePath(args.path);
    if (op === 'list') {
      const entries = await readdir(path, { withFileTypes: true });
      const out = [];
      for (const e of entries.slice(0, 1000)) {
        let size = 0;
        let mtime = 0;
        try {
          const st = await stat(join(path, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* broken link */ }
        out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, mtime });
      }
      out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return { path, entries: out };
    }
    if (op === 'read') {
      const st = await stat(path);
      if (st.isDirectory()) return this.fs('list', args);
      if (st.size > MAX_READ) throw new Error(`File is ${st.size} bytes; too large to read (limit ${MAX_READ}). Use the shell to inspect it.`);
      const buf = await readFile(path);
      const mime = MIME[extname(path).toLowerCase()] || (TEXT_EXT.test(path) ? 'text/plain' : 'application/octet-stream');
      const looksText = TEXT_EXT.test(path) || (!buf.subarray(0, 4096).includes(0) && !mime.startsWith('image/') && mime !== 'application/pdf');
      return looksText ? { path, size: st.size, mime, text: buf.toString('utf8') } : { path, size: st.size, mime, base64: buf.toString('base64') };
    }
    if (op === 'write' || op === 'append') {
      mkdirSync(dirname(path), { recursive: true });
      const data = args.base64 != null ? Buffer.from(args.base64, 'base64') : String(args.text ?? '');
      if (op === 'append' || args.append) await appendFile(path, data);
      else await writeFile(path, data);
      return { path, size: statSync(path).size };
    }
    if (op === 'delete') {
      await rm(path, { recursive: !!args.recursive, force: false });
      return { path, deleted: true };
    }
    throw new Error(`Unknown file operation "${op}"`);
  }

  // ----- web -------------------------------------------------------------------

  fetchPage(url, { signal } = {}) {
    return fetchPage(url, { signal });
  }

  search(query, { max = 8, braveKey, signal } = {}) {
    return webSearch(query, { max, braveKey, signal });
  }

  // ----- desktop (screen, mouse, keyboard) ------------------------------------------

  /** Screen actions run one at a time on each screen, so bots and the phone
   * never interleave clicks. `owner`: the bot, when it has a screen of its own. */
  serialDesktop(fn, owner) {
    // The bots' screens are on one display, with one mouse and keyboard.
    const key = this.ownScreen(owner) ? 'bots' : '';
    if (key) this.screens.touch(owner);
    const prev = this.desktopQueues.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.desktopQueues.set(key, tail);
    tail.then(() => {
      if (this.desktopQueues.get(key) === tail) this.desktopQueues.delete(key);
    });
    return run;
  }

  async screenshot({ maxWidth = 1280, quality = 70, agentId } = {}) {
    return this.serialDesktop(async () => {
      const d = await this.desktop(agentId);
      const s = await d.screenshot({ maxWidth, quality });
      return { base64: s.data, mime: s.mime, width: s.width, height: s.height, screenWidth: s.screenWidth, screenHeight: s.screenHeight };
    }, agentId);
  }

  /**
   * One desktop action, then a fresh screenshot so the model sees the result.
   * x/y are pixels in a screenshot `imageWidth` wide (default: the standard
   * 1280-wide screenshot), mapped onto the real screen here. `agentId`: the
   * bot, whose own screen it is when it has one.
   */
  async desktopAction(action, args = {}) {
    if (action === 'wait') await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0.2, Number(args.seconds) || 1)) * 1000));
    return this.serialDesktop(async () => {
      const d = await this.desktop(args.agentId);
      const info = await d.info();
      if (!info.screenshotAvailable && !info.inputAvailable) throw new Error(`Screen control isn't available on this computer. ${(info.notes || []).join(' ')}`.trim());
      const maxWidth = Number(args.maxWidth) || 1280;
      const imageWidth = Number(args.imageWidth) || Math.min(maxWidth, info.width || maxWidth);
      const scale = info.width ? info.width / imageWidth : 1;
      const map = (v, size) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min((size || 1e6) - 1, Math.round(Number(v) * scale))));
      const X = (v) => map(v, info.width);
      const Y = (v) => map(v, info.height);
      const needsInput = !['screenshot', 'wait'].includes(action);
      if (needsInput && !info.inputAvailable) throw new Error(`Mouse and keyboard control isn't available on this computer. ${(info.notes || []).join(' ')}`.trim());
      const center = { x: Math.round((info.width || 1280) / 2), y: Math.round((info.height || 800) / 2) };
      switch (action) {
        case 'screenshot':
        case 'wait':
          break;
        case 'click':
          await d.click(X(args.x), Y(args.y), { button: args.button || 'left', double: !!args.double });
          break;
        case 'double_click':
          await d.click(X(args.x), Y(args.y), { button: 'left', double: true });
          break;
        case 'right_click':
          await d.click(X(args.x), Y(args.y), { button: 'right' });
          break;
        case 'middle_click':
          await d.click(X(args.x), Y(args.y), { button: 'middle' });
          break;
        case 'move':
          await d.move(X(args.x) ?? center.x, Y(args.y) ?? center.y);
          break;
        case 'drag':
          await d.drag(X(args.x), Y(args.y), X(args.to_x ?? args.x2), Y(args.to_y ?? args.y2));
          break;
        case 'type':
          await d.type(String(args.text ?? ''));
          break;
        case 'key':
          await d.key(String(args.keys || args.key || ''));
          break;
        case 'scroll':
          await d.scroll(X(args.x) ?? center.x, Y(args.y) ?? center.y, { direction: args.direction || 'down', amount: Number(args.amount) || 5 });
          break;
        case 'cursor': {
          const c = await d.cursor();
          return { cursor: { x: Math.round(c.x / scale), y: Math.round(c.y / scale) } };
        }
        default:
          throw new Error(`Unknown desktop action "${action}"`);
      }
      if (needsInput) await new Promise((r) => setTimeout(r, Number(args.settleMs) || 600));
      const shot = await d.screenshot({ maxWidth, quality: Number(args.quality) || 65 });
      return { ok: true, action, screenshot: { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height }, screen: { width: info.width, height: info.height } };
    }, args.agentId);
  }

  // ----- browser (Chrome via DevTools Protocol) --------------------------------------

  /** Each bot gets its own tab; actions for the same owner run one at a time. */
  serialBrowser(owner, fn) {
    const prev = this.browserQueues.get(owner) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.browserQueues.set(owner, tail);
    tail.then(() => {
      if (this.browserQueues.get(owner) === tail) this.browserQueues.delete(owner);
    });
    return run;
  }

  async browser(action, args = {}) {
    const owner = args.agentId || args.owner || 'user';
    const own = this.ownScreen(owner);
    // A look at a browser that isn't open doesn't start it.
    if (action === 'screenshot' && args.ifRunning && !this.browserInstance?.running) return { running: false };
    if (own) this.screens.touch(owner);
    const b = await this.browserApi();
    const o = { owner, tab: args.tab || undefined };
    if (action === 'screenshot') {
      const s = await b.screenshot({ quality: Number(args.quality) || 70, maxWidth: Number(args.maxWidth) || 1280 }, o);
      return { running: true, url: s.url, title: s.title, tab: s.tab, screenshot: s.data, width: s.width, height: s.height };
    }
    if (action === 'close') {
      // A bot with a window of its own closes that; the browser stays for the others.
      if (own) {
        await b.release(owner);
        return { note: 'Closed your browser window.' };
      }
      await b.close();
      this.browserInstance = null;
      return { note: 'Closed the browser.' };
    }
    const map = {
      goto: () => b.goto(args.url, o),
      snapshot: () => b.snapshot(o),
      click: () => b.click({ ref: args.ref, selector: args.selector, text: args.text }, o),
      type: () => b.type({ ref: args.ref, selector: args.selector, text: args.text ?? '', submit: !!args.submit, clear: args.clear !== false }, o),
      type_text: () => b.typeText(args.text ?? '', o),
      press: () => b.press(args.key || args.keys || 'Enter', o),
      scroll: () => b.scroll({ direction: args.direction || 'down', amount: args.amount }, o),
      back: () => b.back(o),
      forward: () => b.forward(o),
      reload: () => b.reload(o),
      tabs: async () => ({ tabs: await b.listTabs(o) }),
      new_tab: () => b.newTab(args.url || 'about:blank', o),
      switch_tab: () => b.switchTab(args.id || args.tab, o),
      close_tab: () => b.closeTab(args.id, o),
      click_xy: () => b.clickXY(Number(args.x), Number(args.y), o),
      evaluate: async () => ({ result: await b.evaluate(args.expression || args.js || '', o) }),
    };
    const fn = map[action];
    if (!fn) throw new Error(`Unknown browser action "${action}"`);
    return this.serialBrowser(o.owner, async () => {
      let state = await fn();
      if (args.quick && state) {
        const { text, ...rest } = state;
        state = rest;
      }
      if (args.withScreenshot) {
        const s = await b.screenshot({ quality: 60 }, { owner: o.owner, tab: state?.tab || o.tab });
        return { ...state, screenshot: s.data, width: s.width, height: s.height, tab: s.tab };
      }
      return state;
    });
  }

  // ----- MCP plugins -------------------------------------------------------

  async mcpList() {
    return { servers: this.mcp.list() };
  }

  async mcpCall(server, tool, args) {
    return this.mcp.call(server, tool, args);
  }

  async close() {
    this.mcp.stop();
    this.screens?.closeAll();
    try {
      await this.browserInstance?.close();
    } catch { /* already closed */ }
    try {
      await (await this.desktopPromise)?.close();
    } catch { /* not started */ }
  }
}

export function defaultWorkspace() {
  return join(os.homedir(), 'Holly');
}

export function describeFile(p) {
  return basename(p);
}
