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
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Holly Bot Computer' } });
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

/** An error the app is shown, with the HTTP status that goes with it. */
function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

/** One server's settings as the app sent them, checked and tidied: a command
 * to run, its arguments, environment and folder, and whether it's off. */
function checkSpec(name, spec) {
  if (typeof name !== 'string' || !name.trim() || name.length > 64) throw problem(400, 'Give each server a name, up to 64 characters.');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw problem(400, `"${name}" has no settings.`);
  if (typeof spec.command !== 'string' || !spec.command.trim()) throw problem(400, `"${name}" needs a command to run, such as npx.`);
  if (spec.args != null && !Array.isArray(spec.args)) throw problem(400, `"${name}": args must be a list.`);
  const env = spec.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((v) => v != null && typeof v === 'object')) {
    throw problem(400, `"${name}": env must give each variable a value.`);
  }
  if (spec.cwd != null && typeof spec.cwd !== 'string') throw problem(400, `"${name}": cwd must be a folder.`);
  const out = { command: spec.command.trim(), args: (spec.args || []).map(String) };
  if (Object.keys(env).length) out.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v ?? '')]));
  if (spec.cwd) out.cwd = spec.cwd;
  if (spec.disabled === true) out.disabled = true;
  return out;
}

export class McpHost {
  constructor({ configPath, log = console }) {
    this.configPath = configPath;
    this.log = log;
    this.servers = new Map();
  }

  /** The whole file (creating it the first time); `strict` throws when it can't be read rather than treating it as empty. */
  readFile(strict = false) {
    if (!existsSync(this.configPath)) {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, { mode: 0o600 });
    }
    try {
      const data = JSON.parse(readFileSync(this.configPath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (err) {
      if (strict) throw problem(409, `Holly Bot Computer can't read ${this.configPath} (${err.message}). Fix or delete that file first.`);
      this.log.warn?.(`Could not parse ${this.configPath}: ${err.message}`);
      return {};
    }
  }

  /** The servers in the file, by name. */
  readConfig() {
    return this.readFile().mcpServers || {};
  }

  /**
   * Changes the servers in the file as the app asks: `add` (`servers` by
   * name, replacing any with the same name), `enable` (`name`, `enabled`) or
   * `remove` (`name`). Everything else in the file stays. The secrets in it
   * (env) stay on this computer: the app is only ever sent names and tools.
   * Resolves once what changed has started or stopped (sync).
   */
  async change({ op, servers, name, enabled } = {}) {
    const file = this.readFile(true);
    const cfg = { ...(file.mcpServers || {}) };
    if (op === 'add') {
      if (!servers || typeof servers !== 'object' || !Object.keys(servers).length) throw problem(400, 'No servers to add.');
      for (const [n, spec] of Object.entries(servers)) cfg[n.trim()] = checkSpec(n.trim(), spec);
    } else if (op === 'enable' || op === 'remove') {
      if (!cfg[name]) throw problem(404, `No MCP server named ${name} on this computer.`);
      if (op === 'remove') delete cfg[name];
      else if (enabled) {
        const { disabled, ...rest } = cfg[name];
        cfg[name] = rest;
      } else cfg[name] = { ...cfg[name], disabled: true };
    } else throw problem(400, `Unknown change "${op}".`);
    writeFileSync(this.configPath, `${JSON.stringify({ ...file, mcpServers: cfg }, null, 2)}\n`, { mode: 0o600 });
    return this.sync();
  }

  /**
   * Runs what the file lists. Servers taken out or switched off stop; new or
   * changed ones start, and so do ones that stopped with an error; the rest
   * keep running as they are. Resolves once the ones starting are up (or
   * failed).
   */
  async sync() {
    const want = new Map(Object.entries(this.readConfig()).filter(([, spec]) => spec && spec.command && spec.disabled !== true));
    for (const [name, s] of this.servers) {
      if (JSON.stringify(want.get(name)) !== JSON.stringify(s.spec)) {
        s.stop();
        this.servers.delete(name);
      }
    }
    await Promise.all([...want].map(async ([name, spec]) => {
      const running = this.servers.get(name);
      if (running && running.status !== 'error') return;
      running?.stop();
      const s = new StdioServer(name, spec, this.log);
      this.servers.set(name, s);
      await s.start();
      this.log.log?.(`  plugin ${name}: ${s.status === 'ok' ? `${s.tools.length} tools` : `error — ${s.error}`}`);
    }));
    return this.list();
  }

  async start() {
    await this.sync();
  }

  async reload() {
    this.stop();
    this.servers.clear();
    await this.start();
  }

  /** Each server: running ones with their state and tools, and the ones switched off in the file as 'off'. */
  list() {
    const out = [...this.servers.values()].map((s) => ({ name: s.name, status: s.status, error: s.error, tools: s.tools }));
    for (const [name, spec] of Object.entries(this.readConfig())) {
      if (spec?.disabled === true && !this.servers.has(name)) out.push({ name, status: 'off', error: '', tools: [] });
    }
    return out;
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
