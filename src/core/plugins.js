import { McpHttpClient } from './mcp.js';
import { mcpTools } from './tools/index.js';

// Plugins = MCP servers. Remote servers are called straight from the browser
// (they must allow CORS); local stdio servers run on the Bot Computer.

export class PluginManager {
  constructor(app) {
    this.app = app;
    this.clients = new Map(); // server id -> McpHttpClient
    this.state = new Map(); // server key -> { name, via, status, error, tools: [] }
  }

  list() {
    return [...this.state.values()];
  }

  async refresh() {
    const next = new Map();
    const servers = (this.app.settings.mcpServers || []).filter((s) => s.enabled !== false && s.url);
    await Promise.all(servers.map(async (s) => {
      const key = `direct:${s.id}`;
      next.set(key, { key, id: s.id, name: s.name, via: 'direct', status: 'loading', tools: [] });
      try {
        let client = this.clients.get(s.id);
        if (!client || client.url !== s.url) {
          client = new McpHttpClient({ url: s.url, headers: s.headers || {}, name: s.name });
          this.clients.set(s.id, client);
        }
        const tools = await client.listTools();
        next.set(key, { key, id: s.id, name: s.name, via: 'direct', status: 'ok', tools });
      } catch (err) {
        next.set(key, { key, id: s.id, name: s.name, via: 'direct', status: 'error', error: err.message, tools: [] });
      }
    }));
    if (this.app.computer?.connected && this.app.computer.info?.capabilities?.mcp) {
      try {
        const res = await this.app.computer.mcpList();
        for (const srv of res.servers || []) {
          const key = `computer:${srv.name}`;
          next.set(key, { key, id: srv.name, name: srv.name, via: 'computer', status: srv.status || 'ok', error: srv.error, tools: srv.tools || [] });
        }
      } catch (err) {
        next.set('computer:*', { key: 'computer:*', name: 'Bot Computer', via: 'computer', status: 'error', error: err.message, tools: [] });
      }
    }
    this.state = next;
    this.app.emit('plugins');
    return this.list();
  }

  /** Tool definitions for a bot (respecting per-bot plugin switches). */
  toolsFor(agent) {
    const out = [];
    for (const s of this.state.values()) {
      if (s.status !== 'ok' || !s.tools.length) continue;
      if (agent?.plugins?.[s.name] === false) continue;
      const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
      const call = s.via === 'computer'
        ? (tool, args, opts) => this.app.computer.mcpCall(s.name, tool, args, opts)
        : (tool, args, opts) => this.clients.get(s.id).callTool(tool, args, opts);
      out.push(...mcpTools(slug, s.tools, call, { via: s.via }));
    }
    return out;
  }
}
