import { safeJsonParse } from './util.js';

// Client for Holly Computer — the optional companion program (computer/holly-computer.mjs)
// that gives bots a real computer: shell, files, page fetching without CORS
// limits, web search, screenshots, a browser, and local MCP servers.

export class ComputerClient {
  constructor({ url = '', token = '' } = {}) {
    this.configure({ url, token });
    this.info = null;
    this.connected = false;
    this.error = '';
  }

  configure({ url, token }) {
    this.url = String(url || '').trim().replace(/\/+$/, '');
    this.token = String(token || '').trim();
  }

  get configured() {
    return !!(this.url && this.token);
  }

  headers(json = true) {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async request(path, body, { signal, method } = {}) {
    if (!this.configured) throw new Error('No Bot Computer connected (Settings → Bot Computer).');
    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      this.connected = false;
      throw new Error(`Bot Computer unreachable at ${this.url} — is holly-computer running? (${err.message})`);
    }
    const text = await res.text();
    const data = safeJsonParse(text, { error: text });
    if (!res.ok) throw new Error(data?.error || `Bot Computer error ${res.status}`);
    return data;
  }

  async connect({ signal } = {}) {
    try {
      this.info = await this.request('/v1/info', undefined, { signal });
      this.connected = true;
      this.error = '';
    } catch (err) {
      this.connected = false;
      this.error = err.message;
      throw err;
    }
    return this.info;
  }

  /**
   * Run a shell command. It runs as a job on the computer and output is fetched
   * in pieces (works through tunnels and proxies); onData(stream, chunk) gets it live.
   */
  async exec(command, { cwd, timeoutMs = 120000, onData, signal, background = false } = {}) {
    let stdout = '';
    let stderr = '';
    const take = (chunks) => {
      for (const c of chunks || []) {
        if (c.stream === 'stderr') stderr += c.data;
        else stdout += c.data;
        onData?.(c.stream, c.data);
      }
    };
    let r = await this.request('/v1/exec', { command, cwd, timeoutMs, background }, { signal });
    take(r.chunks);
    try {
      while (!r.done) {
        r = await this.request(`/v1/jobs/${r.job}?since=${r.next}`, undefined, { signal });
        take(r.chunks);
      }
    } catch (err) {
      if (err?.name === 'AbortError') this.request(`/v1/jobs/${r.job}/kill`, {}).catch(() => {});
      throw err;
    }
    return { stdout, stderr, code: r.done.code, signal: r.done.signal, durationMs: r.done.durationMs, cwd: r.done.cwd };
  }

  fs(op, args, opts) {
    return this.request(`/v1/fs/${op}`, args, opts);
  }

  fetchPage(url, { signal } = {}) {
    return this.request('/v1/fetch', { url }, { signal });
  }

  search(query, { max = 6, braveKey, signal } = {}) {
    return this.request('/v1/search', { query, max, braveKey }, { signal });
  }

  screenshot({ signal, maxWidth, quality } = {}) {
    return this.request('/v1/screenshot', { maxWidth, quality }, { signal });
  }

  /** Desktop control: screenshot | click | double_click | right_click | move | drag | type | key | scroll | wait | cursor. */
  desktopAction(action, args = {}, { signal } = {}) {
    return this.request('/v1/desktop', { action, ...args }, { signal });
  }

  browser(action, args = {}, { signal } = {}) {
    return this.request('/v1/browser', { action, ...args }, { signal });
  }

  mcpList({ signal } = {}) {
    return this.request('/v1/mcp', undefined, { signal });
  }

  mcpCall(server, tool, args, { signal } = {}) {
    return this.request('/v1/mcp/call', { server, tool, arguments: args }, { signal });
  }
}

/** Commands that only read state run without approval even when Auto-review is on. */
const SAFE_COMMAND = /^\s*(ls|dir|pwd|cd|echo|cat|type|head|tail|wc|whoami|hostname|date|uname|which|where|where\.exe|env|printenv|df|du|free|uptime|ps|tasklist|Get-ChildItem|Get-Content|Get-Location|Get-Date|Get-Process|git\s+(status|log|diff|branch|show|remote)|node\s+(-v|--version)|python3?\s+(-V|--version)|npm\s+(-v|--version|ls|list)|pip3?\s+(list|show|--version))\b[^;&|><`$]*$/i;

export function isSafeCommand(cmd) {
  return SAFE_COMMAND.test(String(cmd || ''));
}
