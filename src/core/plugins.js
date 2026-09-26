import { McpHttpClient } from './mcp.js';
import { mcpTools } from './tools/index.js';
import { bannedInImagePrompt } from './safety.js';

// Plugins = MCP servers. Remote servers are called straight from the browser
// (they must allow CORS); local stdio servers run on the Bot Computer. And
// Higgsfield, once connected in Settings → Plugins: its own MCP server, which
// only takes calls from servers, so bots reach it through Holli Bot's, which
// keeps the sign-in (convex/connectors.ts, convex/lib/higgsfield.ts).

/** Connected services whose tools are their own MCP server's. */
const CONNECTED = [{ id: 'higgsfield', name: 'Higgsfield' }];

export class PluginManager {
  constructor(app) {
    this.app = app;
    this.clients = new Map(); // server id -> McpHttpClient
    this.state = new Map(); // server key -> { name, via, status, error, tools: [] }
    // Connecting Higgsfield brings its tools; disconnecting takes them away.
    app.on?.('connections', () => this.refresh().catch(() => {}));
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
    await this.app.refreshConnections?.({ maxAge: 60_000 });
    for (const c of CONNECTED) {
      if (!this.app.connection?.(c.id)) continue;
      const key = `connector:${c.id}`;
      try {
        const tools = await this.app.connector(c.id, 'tools');
        next.set(key, { key, id: c.id, name: c.name, via: 'connector', status: 'ok', tools: Array.isArray(tools) ? tools : [] });
      } catch (err) {
        next.set(key, { key, id: c.id, name: c.name, via: 'connector', status: 'error', error: err.message, tools: [] });
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
        : s.via === 'connector'
          ? (tool, args, opts) => this.callConnected(s.id, tool, args, opts)
          : (tool, args, opts) => this.clients.get(s.id).callTool(tool, args, opts);
      out.push(...mcpTools(slug, s.tools, call, { via: s.via }));
    }
    return out;
  }

  /** Runs one of a connected service's tools through Holli Bot's server. What
   * a bot asks Higgsfield to make is checked first, as generate_image's
   * prompt is (src/core/safety.js); Higgsfield's own moderation checks what
   * it makes. */
  async callConnected(id, tool, args, opts) {
    const banned = bannedInImagePrompt(JSON.stringify(args ?? {}));
    if (banned) {
      return { content: [{ type: 'text', text: `Not made: the request asks for ${banned}, which isn't allowed (Content rules). Don't try again with other words: tell the user in a sentence that you can't make that.` }], isError: true };
    }
    return this.app.connector(id, 'call', { name: tool, arguments: args }, opts);
  }
}
