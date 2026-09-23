import { Emitter, uid } from '../core/util.js';
import { ComputerClient } from '../core/computer.js';
import { ProviderHub } from '../core/providers/index.js';
import { DEFAULT_SETTINGS } from '../core/app.js';

// Remote control: the same interface as the local App, but every bot, chat,
// memory and file lives on your Holly Computer. Live updates arrive by long
// polling (works through any tunnel or proxy); actions are RPC calls. The UI
// can't tell the difference.

export class RemoteApp {
  constructor({ url, token, name = '' }) {
    this.base = String(url || '').replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.remote = true;
    this.host = 'computer';
    this.clientId = uid('client');
    this.events = new Emitter();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.providersReady = [];
    this.imageProviderId = null;
    this.tz = '';
    this.agents = new Map();
    this.threads = new Map();
    this.tasks = new Map();
    this.messageCache = new Map();
    this.activity = [];
    this.pluginList = [];
    this.viewingThreadId = null;
    this.connection = 'connecting';
    this.server = null;

    this.computer = new ComputerClient({ url: this.base || location.origin, token });
    const hub = new ProviderHub(this);
    hub.isReady = (id) => this.providersReady.includes(id);
    hub.imageProvider = () => this.imageProviderId;
    hub.test = (id) => this.rpc('providers.test', id);
    hub.balance = (id) => this.rpc('providers.balance', id);
    this.providers = hub;

    const self = this;
    this.runtime = {
      runs: new Map(),
      isThreadBusy: (id) => self.runtime.runs.has(id),
      isAgentBusy: (id) => [...self.runtime.runs.values()].some((r) => r.agentId === id),
      activeRuns: () => [...self.runtime.runs.values()],
      send: (threadId, payload) => self.rpc('runtime.send', threadId, payload),
      answer: (m, c, a) => self.rpc('runtime.answer', m, c, a),
      dismiss: (m, c) => self.rpc('runtime.dismiss', m, c),
      approve: (m, c, d) => self.rpc('runtime.approve', m, c, d),
      retry: (m) => self.rpc('runtime.retry', m),
      regenerate: (m) => self.rpc('runtime.regenerate', m),
      stop: (threadId) => self.rpc('runtime.stop', threadId),
      stopAll: () => self.rpc('runtime.stopAll'),
      runRoutine: (r) => self.rpc('runtime.runRoutine', r.id),
    };
    this.memory = {
      list: (owner, opts) => self.rpc('memory.list', owner, opts),
      search: (owner, q, opts) => self.rpc('memory.search', owner, q, opts),
      count: (owner) => self.rpc('memory.count', owner),
      get: (id) => self.rpc('memory.get', id),
      add: (owner, data) => self.rpc('memory.add', owner, data),
      update: (id, patch) => self.rpc('memory.update', id, patch),
      remove: (id) => self.rpc('memory.remove', id),
      reindex: (agentId) => self.rpc('memory.reindex', agentId),
    };
    this.files = {
      list: (agentId, prefix) => self.rpc('files.list', agentId, prefix),
      readText: (agentId, path) => self.rpc('files.readText', agentId, path),
      remove: (agentId, path) => self.rpc('files.remove', agentId, path),
      getById: (id) => self.getFile(id),
      write: (agentId, path, content, opts = {}) => self.writeFile(agentId, path, content, opts),
    };
    this.routines = {
      list: (agentId) => self.rpc('routines.list', agentId),
      create: (data) => self.rpc('routines.create', data),
      update: (id, patch) => self.rpc('routines.update', id, patch),
      remove: (id) => self.rpc('routines.remove', id),
      setAllEnabled: (enabled) => self.rpc('routines.setAllEnabled', enabled),
    };
    this.plugins = {
      list: () => self.pluginList,
      refresh: async () => {
        self.pluginList = await self.rpc('plugins.refresh');
        self.emit('plugins');
        return self.pluginList;
      },
      toolsFor: () => [],
    };
  }

  // ----- transport -----------------------------------------------------------

  url(path) {
    return `${this.base}${path}`;
  }

  /** URL for server-hosted images/files (token in the query so <img> can load it). */
  assetUrl(path) {
    return `${this.url(path)}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
  }

  headers(json = true) {
    return { Authorization: `Bearer ${this.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async rpc(method, ...args) {
    let res;
    try {
      res = await fetch(this.url('/api/rpc'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ method, args, clientId: this.clientId }) });
      // Slow calls come back as a ticket; collect the result.
      while (res.status === 202) {
        const { pending } = await res.json();
        res = await fetch(this.url(`/api/rpc-result/${pending}`), { headers: this.headers(false) });
      }
    } catch (err) {
      throw new Error(`Can't reach your Holly Computer (${err.message}). Is it running?`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Holly Computer error ${res.status}`);
    return data.result;
  }

  async connect({ timeoutMs = 12000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.url('/api/state'), { headers: this.headers(false), signal: ctrl.signal });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'Timed out reaching your Holly Computer.' : `Can't reach your Holly Computer: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 401) throw new Error('This pairing link is no longer valid. Open the latest link printed by Holly Computer.');
    if (!res.ok) throw new Error(`Holly Computer error ${res.status}`);
    this.applyState(await res.json());
    this.connection = 'online';
    this.startEvents();
    return this;
  }

  applyState(s) {
    this.seq = s.seq;
    this.boot = s.boot;
    this.server = s.server;
    this.settings = s.settings;
    this.providersReady = s.providersReady || [];
    this.imageProviderId = s.imageProvider || null;
    this.tz = s.timeZone || '';
    this.agents = new Map((s.agents || []).map((a) => [a.id, a]));
    this.threads = new Map((s.threads || []).map((t) => [t.id, t]));
    this.tasks = new Map((s.tasks || []).map((t) => [t.id, t]));
    this.runtime.runs = new Map((s.runs || []).map((r) => [r.threadId, r]));
    this.computer.info = s.computer;
    this.computer.connected = !!s.computer;
    this.pluginList = s.plugins || [];
    for (const t of ['agents', 'threads', 'settings', 'runs', 'tasks', 'computer', 'plugins']) this.emit(t);
  }

  /** Long-poll for events; after being offline, catch up or reload everything. */
  async startEvents() {
    if (this.eventsRunning) return;
    this.eventsRunning = true;
    let backoff = 1000;
    while (!this.closed) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        let res;
        try {
          const q = `since=${this.seq ?? ''}&boot=${encodeURIComponent(this.boot || '')}&client=${encodeURIComponent(this.clientId)}`;
          res = await fetch(this.url(`/api/poll?${q}`), { headers: this.headers(false), signal: ctrl.signal, cache: 'no-store' });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const data = await res.json();
        if (this.connection !== 'online') {
          this.connection = 'online';
          this.emit('connection');
        }
        backoff = 1000;
        if (data.reset) {
          await this.resync();
          continue;
        }
        for (const e of data.events || []) this.handle(e.topic, e.data);
        this.seq = data.seq;
      } catch (err) {
        if (this.closed) break;
        console.warn('live updates', err.message);
        if (this.connection !== 'offline') {
          this.connection = 'offline';
          this.emit('connection');
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
    this.eventsRunning = false;
  }

  /** After a reconnect: refresh state and any chats that are open. */
  async resync() {
    try {
      const res = await fetch(this.url('/api/state'), { headers: this.headers(false), cache: 'no-store' });
      if (!res.ok) throw new Error(`state ${res.status}`);
      this.applyState(await res.json());
      for (const threadId of this.messageCache.keys()) {
        this.messageCache.set(threadId, await this.rpc('messages.list', threadId));
        this.emit(`messages:${threadId}`);
      }
      if (this.viewingThreadId) this.rpc('threads.view', this.viewingThreadId).catch(() => {});
    } catch (err) {
      console.warn('resync failed', err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  handle(topic, data) {
    if (topic === 'agents') this.agents = new Map((data || []).map((a) => [a.id, a]));
    else if (topic === 'threads') this.threads = new Map((data || []).map((t) => [t.id, t]));
    else if (topic === 'tasks') this.tasks = new Map((data || []).map((t) => [t.id, t]));
    else if (topic === 'runs') this.runtime.runs = new Map((data || []).map((r) => [r.threadId, r]));
    else if (topic === 'computer') {
      this.computer.info = data;
      this.computer.connected = !!data;
    } else if (topic === 'plugins') this.pluginList = data || [];
    else if (topic === 'settings') {
      this.settings = data.settings;
      this.providersReady = data.providersReady || [];
      this.imageProviderId = data.imageProvider || null;
      this.tz = data.timeZone || this.tz;
    } else if (topic.startsWith('thread:')) {
      if (data) this.threads.set(data.id, data);
    } else if (topic.startsWith('agent:')) {
      if (data) this.agents.set(data.id, data);
    } else if (topic.startsWith('messages:')) {
      const threadId = topic.slice(9);
      const list = this.messageCache.get(threadId);
      if (list) {
        if (data?.deleted) {
          const i = list.findIndex((m) => m.id === data.id);
          if (i >= 0) list.splice(i, 1);
        } else if (data?.id) {
          const i = list.findIndex((m) => m.id === data.id);
          if (i >= 0) list[i] = data;
          else {
            list.push(data);
            list.sort((a, b) => a.seq - b.seq);
          }
        } else {
          this.rpc('messages.list', threadId).then((rows) => {
            this.messageCache.set(threadId, rows);
            this.emit(topic);
          }).catch(() => {});
          return;
        }
      }
    } else if (topic === 'activity') {
      if (data) this.activity.unshift(data);
    } else if (topic === 'notify') {
      this.emit('notify', { agent: this.getAgent(data?.agentId), text: data?.text, threadId: data?.threadId });
      return;
    }
    this.emit(topic, data);
  }

  on(topic, fn) {
    return this.events.on(topic, fn);
  }

  emit(topic, payload) {
    this.events.emit(topic, payload);
  }

  close() {
    this.closed = true;
  }

  // ----- same surface as App -----------------------------------------------------

  hidden() {
    return document.visibilityState === 'hidden';
  }

  timeZone() {
    return this.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  listAgents() {
    return [...this.agents.values()].filter((a) => !a.archived).sort((a, b) => a.createdAt - b.createdAt);
  }

  getAgent(id) {
    return this.agents.get(id) || null;
  }

  findAgent(nameOrId) {
    if (!nameOrId) return null;
    if (this.agents.has(nameOrId)) return this.agents.get(nameOrId);
    const n = String(nameOrId).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return this.listAgents().find((a) => a.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === n) || null;
  }

  createAgent(data) {
    return this.rpc('agents.create', data);
  }

  updateAgent(id, patch) {
    const a = this.agents.get(id);
    if (a) {
      this.agents.set(id, { ...a, ...patch });
      this.emit('agents');
    }
    return this.rpc('agents.update', id, patch);
  }

  deleteAgent(id) {
    return this.rpc('agents.delete', id);
  }

  listThreads({ includeAgentChannels = false } = {}) {
    return [...this.threads.values()]
      .filter((t) => includeAgentChannels || t.kind !== 'agents')
      .sort((a, b) => (b.preview?.at || b.updatedAt) - (a.preview?.at || a.updatedAt));
  }

  getThread(id) {
    return this.threads.get(id) || null;
  }

  createGroup(data) {
    return this.rpc('threads.createGroup', data);
  }

  updateThread(id, patch) {
    return this.rpc('threads.update', id, patch);
  }

  deleteThread(id) {
    return this.rpc('threads.delete', id);
  }

  clearThread(id) {
    this.messageCache.set(id, []);
    return this.rpc('threads.clear', id);
  }

  markRead(id) {
    const t = this.threads.get(id);
    if (t?.unread) return this.rpc('threads.markRead', id);
    return null;
  }

  isViewing(threadId) {
    return this.viewingThreadId === threadId;
  }

  setViewing(threadId) {
    this.viewingThreadId = threadId;
    this.rpc('threads.view', threadId || null).catch(() => {});
  }

  async loadMessages(threadId) {
    if (this.messageCache.has(threadId)) return this.messageCache.get(threadId);
    const rows = await this.rpc('messages.list', threadId);
    this.messageCache.set(threadId, rows);
    return rows;
  }

  async getMessage(id) {
    for (const list of this.messageCache.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return this.rpc('messages.get', id);
  }

  deleteMessage(id) {
    return this.rpc('messages.delete', id);
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.emit('settings');
    return this.rpc('settings.save', patch);
  }

  setProvider(id, patch) {
    const cur = this.settings.providers?.[id] || {};
    return this.saveSettings({ providers: { ...this.settings.providers, [id]: { ...cur, ...patch } } });
  }

  loadActivity(agentId, limit) {
    return this.rpc('activity.load', agentId, limit);
  }

  reflectNow(agentId) {
    return this.rpc('memory.reflect', agentId);
  }

  exportData(opts) {
    return this.rpc('data.export', opts);
  }

  importData(data) {
    return this.rpc('data.import', data);
  }

  resetAll() {
    return this.rpc('data.reset');
  }

  startScheduler() { /* routines run on the computer */ }

  stopScheduler() {}

  async getFile(id) {
    const meta = await this.rpc('files.meta', id);
    if (!meta) return null;
    const res = await fetch(this.url(`/api/files/${encodeURIComponent(id)}`), { headers: this.headers(false) });
    if (!res.ok) return meta;
    if (meta.hasText) return { ...meta, text: await res.text() };
    return { ...meta, blob: await res.blob() };
  }

  async writeFile(agentId, path, content, { mime, source = 'user' } = {}) {
    if (typeof content === 'string') return this.rpc('files.write', agentId, path, { text: content, mime, source });
    const buf = new Uint8Array(await content.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return this.rpc('files.write', agentId, path, { base64: btoa(bin), mime: mime || content.type, source });
  }
}

// ----- connection storage ---------------------------------------------------------

const KEY = 'holly.connection';

export function savedConnection() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveConnection(conn) {
  try {
    if (conn) localStorage.setItem(KEY, JSON.stringify(conn));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
}

/** Pairing links: #connect=<base64url JSON {url, token}> (url '' = this same server). */
export function takeConnectLink() {
  const m = location.hash.match(/[#&]connect=([^&]+)/);
  if (!m) return null;
  try {
    const json = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    if (!json.token) return null;
    return { url: json.url || location.origin, token: json.token, name: json.name || '' };
  } catch {
    return null;
  }
}
