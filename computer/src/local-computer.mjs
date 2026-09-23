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

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|svg|ya?ml|toml|ini|cfg|conf|log|sh|bash|zsh|ps1|psm1|bat|cmd|sql|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|lua|r|tex|env|gitignore|dockerfile)$/i;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/html', '.md': 'text/markdown', '.csv': 'text/csv', '.svg': 'image/svg+xml' };
const MAX_READ = 8 * 1024 * 1024;

export const VERSION = '1.0.0';

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
    this.browserInstance = null;
    this.mcp = new McpHost({ configPath: join(dataDir, 'mcp.json'), log });
    mkdirSync(workspace, { recursive: true });
  }

  configure() { /* nothing to configure in-process */ }

  async start() {
    await this.mcp.start().catch((err) => this.log.warn?.(`plugins: ${err.message}`));
    await this.connect();
  }

  async desktop() {
    this.desktopPromise ||= import('./desktop.mjs').then((m) => m.createDesktop({ log: this.log })).catch((err) => {
      this.desktopPromise = null;
      throw err;
    });
    return this.desktopPromise;
  }

  async browserApi() {
    if (this.browserInstance) return this.browserInstance;
    const { CdpBrowser, findChrome } = await import('./browser-cdp.mjs');
    const executablePath = findChrome();
    if (!executablePath) throw new Error('No Chrome, Edge, Chromium or Brave found. Install Chrome, or set HOLLY_BROWSER to the browser executable path.');
    this.browserInstance = new CdpBrowser({ executablePath, userDataDir: join(this.dataDir, 'browser-profile'), headless: this.headlessBrowser, log: this.log });
    return this.browserInstance;
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

  async screenshot({ maxWidth = 1280, quality = 70 } = {}) {
    const d = await this.desktop();
    const s = await d.screenshot({ maxWidth, quality, format: 'jpeg' });
    return { base64: s.data, mime: s.mime, width: s.width, height: s.height, screenWidth: s.screenWidth, screenHeight: s.screenHeight };
  }

  /** One desktop action, then a fresh screenshot so the model sees the result. */
  async desktopAction(action, args = {}) {
    const d = await this.desktop();
    const num = (v) => Math.round(Number(v));
    switch (action) {
      case 'screenshot':
        break;
      case 'click':
        await d.click(num(args.x), num(args.y), { button: args.button || 'left', double: !!args.double });
        break;
      case 'double_click':
        await d.click(num(args.x), num(args.y), { button: 'left', double: true });
        break;
      case 'right_click':
        await d.click(num(args.x), num(args.y), { button: 'right' });
        break;
      case 'move':
        await d.move(num(args.x), num(args.y));
        break;
      case 'drag':
        await d.drag(num(args.x), num(args.y), num(args.to_x ?? args.x2), num(args.to_y ?? args.y2));
        break;
      case 'type':
        await d.type(String(args.text ?? ''));
        break;
      case 'key':
        await d.key(String(args.keys || args.key || ''));
        break;
      case 'scroll':
        await d.scroll(num(args.x ?? 640), num(args.y ?? 400), { direction: args.direction || 'down', amount: Number(args.amount) || 5 });
        break;
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(30, Number(args.seconds) || 1) * 1000));
        break;
      case 'cursor':
        return { cursor: await d.cursor() };
      default:
        throw new Error(`Unknown desktop action "${action}"`);
    }
    if (action !== 'screenshot' && action !== 'wait') await new Promise((r) => setTimeout(r, Number(args.settleMs) || 700));
    const shot = await d.screenshot({ maxWidth: Number(args.maxWidth) || 1280, quality: 65, format: 'jpeg' });
    return { ok: true, action, screenshot: { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height } };
  }

  // ----- browser (Chrome via DevTools Protocol) --------------------------------------

  async browser(action, args = {}) {
    const b = await this.browserApi();
    await b.start();
    const map = {
      goto: () => b.goto(args.url),
      snapshot: () => b.snapshot(),
      click: () => b.click({ ref: args.ref, selector: args.selector, text: args.text }),
      type: () => b.type({ ref: args.ref, selector: args.selector, text: args.text ?? '', submit: !!args.submit, clear: args.clear !== false }),
      type_text: () => b.typeText(args.text ?? ''),
      press: () => b.press(args.key || 'Enter'),
      scroll: () => b.scroll({ direction: args.direction || 'down', amount: args.amount }),
      back: () => b.back(),
      forward: () => b.forward(),
      reload: () => b.reload(),
      tabs: async () => ({ tabs: await b.tabs() }),
      new_tab: () => b.newTab(args.url || 'about:blank'),
      switch_tab: () => b.switchTab(args.id),
      close_tab: () => b.closeTab(args.id),
      click_xy: () => b.clickXY(Number(args.x), Number(args.y)),
      evaluate: async () => ({ result: await b.evaluate(args.expression || args.js || '') }),
      close: async () => {
        await b.close();
        this.browserInstance = null;
        return { note: 'Browser closed.' };
      },
    };
    if (action === 'screenshot') {
      const s = await b.screenshot({ quality: 70 });
      return { url: s.url, title: s.title, screenshot: s.data, width: s.width, height: s.height };
    }
    const fn = map[action];
    if (!fn) throw new Error(`Unknown browser action "${action}"`);
    const state = await fn();
    if (args.withScreenshot) {
      const s = await b.screenshot({ quality: 60 });
      return { ...state, screenshot: s.data, width: s.width, height: s.height };
    }
    return state;
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
