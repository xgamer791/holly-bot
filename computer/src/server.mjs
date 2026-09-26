// Holly Computer HTTP server.
//   /v1/*   the Bot Computer API (shell, files, web, desktop, browser, plugins)
//   /api/*  remote control of the bots that live here (state, live events, RPC, files, images)
//   /       the Holly Bot web app itself (so a phone can open one link)
// Everything except the web app and /v1/health needs the pairing token, or,
// while the computer is linked to an account, the access key it gave the
// account's devices (computer/src/account.mjs).
// Only plain request/response is used — live updates are long polls — so it
// works through Cloudflare quick tunnels (no SSE there) and any proxy, and no
// request is held open longer than ~50s (proxies cut responses at ~100s).

import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { RPC, stateSnapshot, sanitizeMessage, findImage, redactSettings } from './remote-api.mjs';
import { findApps } from './apps.mjs';

const MAX_BODY = 60 * 1024 * 1024;

/** Whether the request carries one of `tokens`. */
function tokenOk(req, url, tokens) {
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '');
  let ok = false;
  for (const token of tokens) {
    const want = Buffer.from(token);
    if (given.length === want.length && timingSafeEqual(given, want)) ok = true;
  }
  return ok;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** The folder two paths both live in. */
function commonParent(a, b) {
  const x = a.split(sep);
  const y = b.split(sep);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep) || sep;
}

/**
 * GET /v1/export: the bots' files as a .tar.gz (the workspace, and the
 * browser profile and plugins in the data folder), with paths relative to the
 * folder both live in. When Holly Bot moves a subscriber to a smaller server,
 * the new one copies them from the old one (convex/lib/cloudinit.ts). Caches
 * and the browser's lock files stay behind.
 */
function exportFiles(res, computer) {
  const root = commonParent(computer.workspace, computer.dataDir);
  const parts = [computer.workspace, join(computer.dataDir, 'browser-profile'), join(computer.dataDir, 'mcp.json')]
    .filter((path) => existsSync(path))
    .map((path) => relative(root, path));
  const excludes = ['Singleton*', '*/Cache', '*/Code Cache', '*/GPUCache', '*/Service Worker/CacheStorage'].map((pattern) => `--exclude=${pattern}`);
  const tar = spawn('tar', ['-czf', '-', ...excludes, '-C', root, ...parts], { stdio: ['ignore', 'pipe', 'ignore'] });
  tar.on('error', () => res.destroy());
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store' });
  tar.stdout.pipe(res);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref());
const HOLD_MS = 25000;
const LONG_MS = 50000;

/**
 * Recent app events for long-polling clients. Events that carry a full state
 * (a message, the agent list…) replace older ones with the same key, so the
 * log stays small and a client that falls behind still gets the latest state.
 */
export class EventHub {
  constructor(serialize, { max = 1000 } = {}) {
    this.serialize = serialize;
    this.max = max;
    this.boot = randomUUID();
    this.seq = 0;
    this.entries = [];
    this.trimmed = 0;
    this.waiters = new Set();
    this.timer = null;
  }

  static keyFor(topic, payload) {
    if (topic.startsWith('messages:')) return payload?.id ? `${topic}|${payload.id}` : null;
    if (topic === 'activity' || topic === 'notify') return null;
    return topic;
  }

  push(topic, payload) {
    if (topic.startsWith('message:')) return; // covered by messages:<thread>
    const key = EventHub.keyFor(topic, payload);
    if (key) {
      const i = this.entries.findIndex((e) => e.key === key);
      if (i >= 0) this.entries.splice(i, 1);
    }
    this.entries.push({ seq: ++this.seq, topic, key, payload });
    if (this.entries.length > this.max) {
      const dropped = this.entries.splice(0, this.entries.length - this.max);
      this.trimmed = dropped[dropped.length - 1].seq;
    }
    // Wake waiting polls a moment later so streaming updates arrive in batches.
    if (this.waiters.size && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        for (const w of [...this.waiters]) w();
      }, 60);
    }
  }

  /** Starts a new log because the app behind it changed (linked to an
   * account, or reloaded from it): every client reloads its state. */
  reset() {
    this.boot = randomUUID();
    this.entries = [];
    this.trimmed = this.seq;
    for (const w of [...this.waiters]) w();
  }

  /** Events after `since`, or { reset } if some were dropped (the client reloads state). */
  read(since, boot) {
    if ((boot && boot !== this.boot) || !Number.isFinite(since) || since < this.trimmed || since > this.seq) return { reset: true, seq: this.seq, boot: this.boot };
    const events = [];
    for (const e of this.entries) {
      if (e.seq <= since) continue;
      if (!('data' in e)) e.data = this.serialize(e.topic, e.payload);
      events.push({ topic: e.topic, data: e.data });
    }
    return { events, seq: this.seq, boot: this.boot };
  }

  /** Answer now if there is news, else hold the request up to HOLD_MS. */
  poll(since, boot, res) {
    let done = false;
    let timer = null;
    const reply = () => {
      if (done) return;
      done = true;
      this.waiters.delete(reply);
      clearTimeout(timer);
      json(res, 200, this.read(since, boot));
    };
    const r = this.read(since, boot);
    if (r.reset || r.events.length) {
      json(res, 200, r);
      return;
    }
    this.waiters.add(reply);
    timer = setTimeout(reply, HOLD_MS);
    res.on('close', () => {
      done = true;
      this.waiters.delete(reply);
      clearTimeout(timer);
    });
  }
}

/** Shell commands as jobs: output is fetched in pieces, so long commands survive proxies. */
class Jobs {
  constructor(computer) {
    this.computer = computer;
    this.jobs = new Map();
    this.killed = new Map(); // id -> when: killed before they started (kill)
  }

  start(body) {
    const own = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) && !this.jobs.has(body.id);
    const id = own ? body.id : randomUUID();
    const job = { id, chunks: [], done: null, ctrl: new AbortController(), waiters: new Set() };
    const wake = () => {
      for (const w of [...job.waiters]) w();
    };
    this.jobs.set(id, job);
    // The app stopped it before this request got here: it never runs.
    if (this.killed.delete(id)) {
      job.done = { code: null, error: 'Stopped' };
      setTimeout(() => this.jobs.delete(id), 10 * 60000).unref();
      return job;
    }
    this.computer.exec(body.command, {
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      background: body.background,
      signal: job.ctrl.signal,
      onData: (stream, data) => {
        job.chunks.push({ stream, data });
        wake();
      },
    }).then((r) => {
      if (r.pid && body.background) job.chunks.push({ stream: 'stdout', data: r.stdout });
      job.done = { code: r.code, signal: r.signal, durationMs: r.durationMs, cwd: r.cwd };
    }, (err) => {
      job.chunks.push({ stream: 'stderr', data: `${err.message}\n` });
      job.done = { code: null, error: err.message };
    }).finally(() => {
      wake();
      setTimeout(() => this.jobs.delete(id), 10 * 60000).unref();
    });
    return job;
  }

  /** Output after chunk `since`; waits for news (or the end) up to `holdMs`. */
  async read(job, since, holdMs) {
    const has = () => job.done || job.chunks.length > since;
    if (!has() && holdMs > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(done, holdMs);
        function done() {
          clearTimeout(t);
          job.waiters.delete(later);
          resolve();
        }
        // Gather a little more output before answering.
        const later = () => setTimeout(done, job.done ? 0 : 250);
        job.waiters.add(later);
      });
    }
    return { job: job.id, chunks: job.chunks.slice(since), next: job.chunks.length, done: job.done };
  }

  /** Stops job `id`, or makes sure it never starts, when the request to start
   * it is still on its way (the app picks the id: src/core/computer.js exec). */
  kill(id) {
    const job = this.jobs.get(id);
    if (job) {
      job.ctrl.abort();
      return true;
    }
    const now = Date.now();
    for (const [k, at] of this.killed) if (now - at > 60_000) this.killed.delete(k);
    if (this.killed.size < 1000) this.killed.set(id, now);
    return false;
  }
}

/** The devices Holly Bot says it's on (src/remote/remote-app.js deviceKind),
 * as this computer's own window says them. */
const DEVICE_WORDS = {
  iphone: 'iPhone', ipad: 'iPad', 'android-phone': 'Android phone', 'android-tablet': 'Android tablet',
  mac: 'Mac', windows: 'Windows PC', linux: 'Linux computer', chromebook: 'Chromebook',
};

/** Linking this computer to a Holly Bot account (computer/src/home.mjs). */
const ACCOUNT_RPC = {
  'account.link': (home, [code]) => home.link(code),
  'account.unlink': (home) => home.unlink(),
};

/**
 * @param {object} o
 * @param {import('../../src/core/app.js').App} o.app
 * @param {import('./home.mjs').BotHome} [o.home]  where the bots are kept; links and unlinks the account, whose access key also opens the API
 * @param {import('./local-computer.mjs').LocalComputer} o.computer
 * @param {string} o.token  the pairing token
 * @param {(path: string) => ({ type: string, body: Buffer } | null)} o.assets  web app files
 * @param {object} o.serverInfo
 */
export function createHollyServer({ app: firstApp, home = null, computer, token, assets, serverInfo, log = console }) {
  const hub = new EventHub(serialize);
  const jobs = new Jobs(computer);
  const longCalls = new Map();
  const seen = new Map(); // clientId → last poll time

  let app = firstApp;
  let unsubscribe = app.on('*', (topic, payload) => hub.push(topic, payload));

  // A phone that stopped polling is no longer looking at a chat.
  const sweep = setInterval(() => {
    for (const [clientId, at] of seen) {
      if (Date.now() - at < HOLD_MS * 2 + 20000) continue;
      seen.delete(clientId);
      app.setViewing(null, clientId);
    }
  }, 20000);
  sweep.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (url.pathname === '/v1/health') {
        // Open to anyone who can reach this computer, so it leaves out which account it's linked to.
        const { account: _account, ...info } = serverInfo;
        return json(res, 200, { ok: true, app: 'holly-computer', ...info });
      }
      if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/')) return serveAsset(url, res);
      if (!tokenOk(req, url, [token, home?.account?.accessKey].filter(Boolean))) return json(res, 401, { error: 'Missing or wrong pairing token. Use the link printed by Holly Computer.' });
      if (url.pathname.startsWith('/v1/')) return await computerApi(req, res, url);
      return await remoteApi(req, res, url);
    } catch (err) {
      log.warn?.(`${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) json(res, err.status || 500, { error: err.message });
      else res.end();
    }
  });

  function serveAsset(url, res) {
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = assets?.(path.replace(/^\/+/, ''));
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
    res.end(file.body);
  }

  // ----- /v1: the computer itself ----------------------------------------------------

  async function computerApi(req, res, url) {
    const p = url.pathname;
    if (p === '/v1/info' && req.method === 'GET') return json(res, 200, await computer.connect());
    if (p === '/v1/export' && req.method === 'GET') return exportFiles(res, computer);
    if (p === '/v1/apps' && req.method === 'GET') return json(res, 200, await findApps({ workspace: computer.workspace }));
    if (p === '/v1/memory' && req.method === 'GET') return json(res, 200, await computer.memory());
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (p === '/v1/exec') {
      const job = jobs.start(body);
      return json(res, 200, await jobs.read(job, 0, LONG_MS));
    }
    const jobOp = p.match(/^\/v1\/jobs\/([\w-]+)(\/kill)?$/);
    if (jobOp) {
      if (jobOp[2]) return json(res, 200, { ok: jobs.kill(jobOp[1]) });
      const job = jobs.jobs.get(jobOp[1]);
      if (!job) return json(res, 404, { error: 'That command is no longer running here.' });
      return json(res, 200, await jobs.read(job, Number(url.searchParams.get('since')) || 0, LONG_MS));
    }
    const fsOp = p.match(/^\/v1\/fs\/(read|write|append|list|delete)$/);
    if (fsOp) return json(res, 200, await computer.fs(fsOp[1], body));
    if (p === '/v1/fetch') return json(res, 200, await computer.fetchPage(body.url));
    if (p === '/v1/search') return json(res, 200, await computer.search(body.query, body));
    if (p === '/v1/screenshot') return json(res, 200, await computer.screenshot(body));
    if (p === '/v1/desktop') return json(res, 200, await computer.desktopAction(body.action, body));
    if (p === '/v1/browser') {
      const { action, ...args } = body;
      return json(res, 200, await computer.browser(action, args));
    }
    if (p === '/v1/mcp' && req.method === 'GET') return json(res, 200, await computer.mcpList());
    if (p === '/v1/mcp/call') return json(res, 200, await computer.mcpCall(body.server, body.tool, body.arguments));
    if (p === '/v1/mcp/servers') {
      // A server fetched by npx the first time can take a while to start: the
      // answer comes after half a minute at most, with it still 'starting',
      // and the bots here get its tools once it's up.
      const done = computer.mcpChange(body);
      done.then(() => app.plugins?.refresh?.()).catch(() => {});
      await Promise.race([done, wait(30_000)]);
      return json(res, 200, await computer.mcpList());
    }
    return json(res, 404, { error: `Unknown endpoint ${p}` });
  }

  // ----- /api: remote control of the bots -----------------------------------------------

  async function remoteApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/state') {
      const at = { seq: hub.seq, boot: hub.boot };
      return json(res, 200, { ...stateSnapshot(app, serverInfo), ...at });
    }
    if (p === '/api/poll') {
      const clientId = url.searchParams.get('client') || 'anon';
      seen.set(clientId, Date.now());
      return hub.poll(Number(url.searchParams.get('since')), url.searchParams.get('boot') || '', res);
    }
    if (p === '/api/rpc' && req.method === 'POST') {
      const { method, args = [], clientId } = await readBody(req);
      if (method === 'devices.hello') return json(res, 200, { result: hello(args[0], clientId) });
      const own = home && ACCOUNT_RPC[method];
      const fn = RPC[method];
      if (!own && !fn) return json(res, 404, { error: `Unknown method ${method}` });
      if (clientId) seen.set(clientId, Date.now());
      const call = Promise.resolve().then(() => (own ? own(home, args) : fn(app, args, { clientId }))).then((v) => ({ result: v ?? null }), (e) => ({ error: e.message || String(e) }));
      const first = await Promise.race([call, wait(LONG_MS)]);
      if (!first) {
        // Slow call (e.g. memory reflection): hand back a ticket to collect it.
        const id = randomUUID();
        longCalls.set(id, call);
        call.finally(() => setTimeout(() => longCalls.delete(id), 10 * 60000).unref());
        return json(res, 202, { pending: id });
      }
      return first.error ? json(res, 500, { error: first.error }) : json(res, 200, first);
    }
    const ticket = p.match(/^\/api\/rpc-result\/([\w-]+)$/);
    if (ticket) {
      const call = longCalls.get(ticket[1]);
      if (!call) return json(res, 404, { error: 'That request is no longer available.' });
      const r = await Promise.race([call, wait(LONG_MS)]);
      if (!r) return json(res, 202, { pending: ticket[1] });
      longCalls.delete(ticket[1]);
      return r.error ? json(res, 500, { error: r.error }) : json(res, 200, r);
    }
    const img = p.match(/^\/api\/msg-image\/([^/]+)\/(part|call)\/([^/]+)(?:\/(\d+))?$/);
    if (img) {
      const m = await app.getMessage(img[1]);
      const found = findImage(m, img[2], img[3], img[4]);
      if (!found?.data) return json(res, 404, { error: 'Image not found' });
      res.writeHead(200, { 'Content-Type': found.mime || 'image/png', 'Cache-Control': 'private, max-age=86400' });
      res.end(Buffer.from(found.data, 'base64'));
      return undefined;
    }
    const file = p.match(/^\/api\/files\/([^/]+)$/);
    if (file) {
      const f = await app.files.getById(decodeURIComponent(file[1]));
      if (!f) return json(res, 404, { error: 'File not found' });
      const bytes = f.blob ? Buffer.from(await f.blob.arrayBuffer()) : Buffer.from(f.text ?? '', 'utf8');
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(f.path.split('/').pop())}"`,
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
      return undefined;
    }
    return json(res, 404, { error: `Unknown endpoint ${p}` });
  }

  /**
   * Holly Bot on a phone (or any device) has just connected to this computer,
   * with Connect the first time (`first`), or by itself after that: this
   * computer's own window says so, and so does its own page (src/ui/app.js),
   * through the live updates every device gets.
   */
  function hello(info, clientId) {
    const kind = DEVICE_WORDS[info?.kind] ? info.kind : 'other';
    const first = info?.first === true;
    const what = `Holly Bot on your ${DEVICE_WORDS[kind] || 'phone'}`;
    log.log?.(first ? `\n  ${what} is connected to this computer. Your bots run here, and you control them from it.\n` : `  ${what} connected.`);
    hub.push('hello', { kind, first, clientId: String(clientId || '').slice(0, 80), at: Date.now() });
    return { ok: true };
  }

  function serialize(topic, payload) {
    switch (topic) {
      case 'agents': return [...app.agents.values()];
      case 'threads': return [...app.threads.values()];
      case 'settings': return { settings: redactSettings(app.settings), providersReady: app.providers.readyProviders(), imageProvider: app.providers.imageProvider(), timeZone: app.timeZone() };
      case 'runs': return app.runtime.activeRuns().map(({ controller, ...r }) => r);
      case 'tasks': return [...app.tasks.values()];
      case 'computer': return app.computer.info;
      case 'plugins': return app.plugins.list().map((p) => ({ ...p, tools: (p.tools || []).map((t) => ({ name: t.name, description: t.description })) }));
      case 'notify': return { agentId: payload?.agent?.id || payload?.agentId, text: payload?.text, threadId: payload?.threadId, ...(payload?.say ? { say: payload.say } : {}) };
      default:
        if (topic.startsWith('messages:')) return payload?.id && !payload.deleted ? sanitizeMessage(payload) : payload ?? null;
        if (topic.startsWith('thread:')) return app.getThread(topic.slice(7));
        if (topic.startsWith('agent:')) return app.getAgent(topic.slice(6));
        return payload ?? null;
    }
  }

  /** Serves `next` from now on (computer/src/home.mjs swaps it in). */
  server.setApp = (next) => {
    if (next === app) return;
    unsubscribe();
    app = next;
    unsubscribe = app.on('*', (topic, payload) => hub.push(topic, payload));
    hub.reset();
  };

  server.on('close', () => clearInterval(sweep));
  server.hub = hub;
  return server;
}
