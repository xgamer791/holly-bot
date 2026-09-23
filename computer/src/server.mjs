// Holly Computer HTTP server.
//   /v1/*   the Bot Computer API (shell, files, web, desktop, browser, plugins)
//   /api/*  remote control of the bots that live here (state, live events, RPC, files, images)
//   /       the Holly Bot web app itself (so a phone can open one link)
// Everything except the web app and /v1/health needs the pairing token.

import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { RPC, stateSnapshot, sanitizeMessage, findImage, redactSettings } from './remote-api.mjs';

const MAX_BODY = 60 * 1024 * 1024;

function tokenOk(req, url, token) {
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  return (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

/**
 * @param {object} o
 * @param {import('../../src/core/app.js').App} o.app
 * @param {import('./local-computer.mjs').LocalComputer} o.computer
 * @param {string} o.token
 * @param {(path: string) => ({ type: string, body: Buffer } | null)} o.assets  web app files
 * @param {object} o.serverInfo
 */
export function createHollyServer({ app, computer, token, assets, serverInfo, log = console }) {
  const clients = new Set();

  // Forward app events to every connected client (message streams are coalesced).
  app.on('*', (topic, payload) => {
    for (const c of clients) c.push(topic, payload);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (url.pathname === '/v1/health') return json(res, 200, { ok: true, app: 'holly-computer', ...serverInfo });
      if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/')) return serveAsset(url, res);
      if (!tokenOk(req, url, token)) return json(res, 401, { error: 'Missing or wrong pairing token. Use the link printed by Holly Computer.' });
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
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (p === '/v1/exec') {
      if (body.stream === false) return json(res, 200, await computer.exec(body.command, body));
      const send = sse(res);
      const ctrl = new AbortController();
      req.on('close', () => ctrl.abort());
      const r = await computer.exec(body.command, {
        cwd: body.cwd, timeoutMs: body.timeoutMs, background: body.background, signal: ctrl.signal,
        onData: (stream, data) => send({ type: stream, data }),
      });
      if (r.pid && body.background) send({ type: 'stdout', data: r.stdout });
      send({ type: 'exit', code: r.code, signal: r.signal, durationMs: r.durationMs, cwd: r.cwd });
      res.end();
      return undefined;
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
    return json(res, 404, { error: `Unknown endpoint ${p}` });
  }

  // ----- /api: remote control of the bots -----------------------------------------------

  async function remoteApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/state') return json(res, 200, stateSnapshot(app, serverInfo));
    if (p === '/api/events') return events(req, res, url);
    if (p === '/api/rpc' && req.method === 'POST') {
      const { method, args = [], clientId } = await readBody(req);
      const fn = RPC[method];
      if (!fn) return json(res, 404, { error: `Unknown method ${method}` });
      const result = await fn(app, args, { clientId });
      return json(res, 200, { result: result === undefined ? null : result });
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

  function events(req, res, url) {
    const send = sse(res);
    const clientId = url.searchParams.get('client') || randomUUID();
    const pendingMsgs = new Map();
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      for (const [key, m] of pendingMsgs) send({ topic: key.split('|')[0], data: sanitizeMessage(m) });
      pendingMsgs.clear();
    };
    const client = {
      push(topic, payload) {
        if (topic.startsWith('messages:') && payload?.id) {
          pendingMsgs.set(`${topic}|${payload.id}`, payload);
          flushTimer ||= setTimeout(flush, 120);
          return;
        }
        if (topic.startsWith('message:')) return; // covered by messages:<thread>
        send({ topic, data: serialize(topic, payload) });
      },
    };
    clients.add(client);
    send({ topic: 'hello', data: { clientId } });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(flushTimer);
      flush();
      clients.delete(client);
      app.setViewing(null, clientId);
    });
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
      case 'notify': return { agentId: payload?.agent?.id || payload?.agentId, text: payload?.text, threadId: payload?.threadId };
      default:
        if (topic.startsWith('thread:')) return app.getThread(topic.slice(7));
        if (topic.startsWith('agent:')) return app.getAgent(topic.slice(6));
        return payload ?? null;
    }
  }

  return server;
}
