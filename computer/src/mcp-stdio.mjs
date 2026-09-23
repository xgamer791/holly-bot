// Local MCP plugins: starts stdio MCP servers listed in ~/.holly/mcp.json
// (same format as Claude Desktop: { "mcpServers": { "name": { "command", "args", "env", "cwd" } } })
// and proxies tools/list + tools/call for the bots.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PROTOCOL = '2025-06-18';

class StdioServer {
  constructor(name, spec, log) {
    Object.assign(this, { name, spec, log, proc: null, nextId: 1, pending: new Map(), buf: '', tools: [], status: 'starting', error: '', restarts: 0 });
  }

  start() {
    const { command, args = [], env = {}, cwd } = this.spec;
    this.status = 'starting';
    this.proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) this.lastStderr = line.slice(-500);
    });
    this.proc.on('error', (err) => this.fail(err.message));
    this.proc.on('exit', (code) => this.fail(`exited with code ${code}${this.lastStderr ? `: ${this.lastStderr}` : ''}`));
    return this.init();
  }

  fail(msg) {
    this.status = 'error';
    this.error = msg;
    for (const p of this.pending.values()) p.reject(new Error(`${this.name}: ${msg}`));
    this.pending.clear();
    this.proc = null;
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Server → client requests we don't support (sampling, roots…): reply with an error.
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Holly Computer' } });
      }
    }
  }

  write(obj) {
    this.proc?.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  rpc(method, params, timeoutMs = 60000) {
    if (!this.proc) return Promise.reject(new Error(`${this.name} is not running (${this.error || 'stopped'})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async init() {
    try {
      await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'holly-computer', version: '1.0.0' } }, 45000);
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      let cursor;
      do {
        const r = await this.rpc('tools/list', cursor ? { cursor } : {});
        tools.push(...(r?.tools || []));
        cursor = r?.nextCursor;
      } while (cursor && tools.length < 500);
      this.tools = tools;
      this.status = 'ok';
      this.error = '';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
    }
  }

  async call(tool, args) {
    if (!this.proc && this.restarts < 5) {
      this.restarts++;
      await this.start();
    }
    return this.rpc('tools/call', { name: tool, arguments: args || {} }, 10 * 60000);
  }

  stop() {
    try {
      this.proc?.kill();
    } catch { /* gone */ }
    this.proc = null;
  }
}

export class McpHost {
  constructor({ configPath, log = console }) {
    this.configPath = configPath;
    this.log = log;
    this.servers = new Map();
  }

  readConfig() {
    if (!existsSync(this.configPath)) {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    }
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf8')).mcpServers || {};
    } catch (err) {
      this.log.warn?.(`Could not parse ${this.configPath}: ${err.message}`);
      return {};
    }
  }

  async start() {
    const cfg = this.readConfig();
    await Promise.all(Object.entries(cfg).filter(([, spec]) => spec && spec.command && spec.disabled !== true).map(async ([name, spec]) => {
      const s = new StdioServer(name, spec, this.log);
      this.servers.set(name, s);
      await s.start();
      this.log.log?.(`  plugin ${name}: ${s.status === 'ok' ? `${s.tools.length} tools` : `error — ${s.error}`}`);
    }));
  }

  async reload() {
    this.stop();
    this.servers.clear();
    await this.start();
  }

  list() {
    return [...this.servers.values()].map((s) => ({ name: s.name, status: s.status, error: s.error, tools: s.tools }));
  }

  async call(server, tool, args) {
    const s = this.servers.get(server);
    if (!s) throw new Error(`No MCP server named ${server}`);
    return s.call(tool, args);
  }

  stop() {
    for (const s of this.servers.values()) s.stop();
  }
}
