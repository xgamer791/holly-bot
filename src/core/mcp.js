import { readSSE } from './providers/sse.js';
import { safeJsonParse } from './util.js';

// Minimal Model Context Protocol client over Streamable HTTP, used for remote
// MCP servers the browser can reach directly (the server must allow CORS).
// Local stdio servers run through the Bot Computer instead.

const PROTOCOL = '2025-06-18';

export class McpHttpClient {
  constructor({ url, headers = {}, name = 'mcp' }) {
    this.url = url;
    this.extraHeaders = headers;
    this.name = name;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
    this.serverInfo = null;
  }

  async rpc(method, params, { signal, notify = false } = {}) {
    const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    const id = notify ? undefined : this.nextId++;
    if (!notify) body.id = id;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.initialized ? { 'MCP-Protocol-Version': PROTOCOL } : {}),
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notify) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${this.name} ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const type = res.headers.get('content-type') || '';
    let msg = null;
    if (type.includes('text/event-stream')) {
      for await (const evt of readSSE(res.body, signal)) {
        const d = safeJsonParse(evt.data);
        if (d && d.id === id && (d.result !== undefined || d.error)) {
          msg = d;
          break;
        }
      }
    } else {
      msg = await res.json();
      if (Array.isArray(msg)) msg = msg.find((m) => m.id === id) || msg[0];
    }
    if (!msg) throw new Error(`MCP ${this.name}: no response to ${method}`);
    if (msg.error) throw new Error(`MCP ${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async init({ signal } = {}) {
    if (this.initialized) return this.serverInfo;
    const result = await this.rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'holli-bot', version: '1.0.0' },
    }, { signal });
    this.serverInfo = result?.serverInfo || null;
    this.initialized = true;
    await this.rpc('notifications/initialized', undefined, { signal, notify: true }).catch(() => {});
    return this.serverInfo;
  }

  async listTools({ signal } = {}) {
    await this.init({ signal });
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal });
      tools.push(...(r?.tools || []));
      cursor = r?.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  async callTool(name, args, { signal } = {}) {
    await this.init({ signal });
    return this.rpc('tools/call', { name, arguments: args || {} }, { signal });
  }
}

/** Convert an MCP tools/call result into our neutral tool result. */
export function mcpResultToTool(result) {
  const parts = [];
  const images = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image' && c.data) images.push({ mime: c.mimeType || 'image/png', data: c.data });
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text || `[resource ${c.resource.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[${c.name || 'resource'}](${c.uri})`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return { content: parts.join('\n\n') || '(empty result)', images, isError: !!result?.isError };
}

export function mcpToolName(server, tool) {
  return `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
