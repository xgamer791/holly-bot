import { Emitter, uid } from '../core/util.js';
import { ComputerClient } from '../core/computer.js';
import { ProviderHub } from '../core/providers/index.js';
import { DEFAULT_SETTINGS } from '../core/app.js';
import { tr } from '../ui/i18n.js';

// Remote control: the same interface as the local App, but every bot, chat,
// memory and file lives on your Holly Computer. Live updates arrive by long
// polling (works through any tunnel or proxy); actions are RPC calls. The UI
// can't tell the difference.

export class RemoteApp {
  constructor({ url, token, name = '', device = null }) {
    this.base = String(url || '').replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.device = device; // the computer's id in the account, when it's linked (convex/devices.ts)
    /** Set by src/main.js for a computer linked to the account: resolves to
     * where it is now ({url, token}) when that has changed, else null. */
    this.relocate = null;
    this.relocatedAt = 0;
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
    /** Whether live updates are coming through (Settings → Bot Computer). */
    this.reachable = false;
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
      stop: (threadId) => self.stopRuns([threadId], () => self.rpc('runtime.stop', threadId)),
      stopAll: () => self.stopRuns([...self.runtime.runs.keys()], () => self.rpc('runtime.stopAll')),
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
      throw new Error(tr("Can't reach your Holly Computer ({error}). Is it running?", { error: err.message }));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || tr('Holly Computer error {status}', { status: res.status }));
    return data.result;
  }

  /**
   * Stop (`call`, for the chats `threadIds`): the chats are free here at
   * once, without waiting for the computer's word, which could be slow or, if
   * this app missed that a turn ended, never come. When the computer can't be
   * reached, they're busy again, as far as anyone can tell, and the error says so.
   */
  async stopRuns(threadIds, call) {
    const before = this.runtime.runs;
    const after = new Map([...before].filter(([id]) => !threadIds.includes(id)));
    if (after.size !== before.size) {
      this.runtime.runs = after;
      this.emit('runs');
    }
    try {
      await call();
    } catch (err) {
      if (this.runtime.runs === after) {
        this.runtime.runs = before;
        this.emit('runs');
      }
      throw new Error(tr("Couldn't stop: {error}", { error: err.message }));
    }
  }

  /** Loads everything from the computer and starts live updates. Fails with
   * `code` 'unreachable' (nothing answered at its address: a browser only
   * says "Load failed" or "Failed to fetch"), 'timeout', 'unauthorized' or 'http'. */
  async connect({ timeoutMs = 12000, live = true } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const name = this.name;
    const fail = (code, message) => Object.assign(new Error(message), { code });
    let res;
    try {
      res = await fetch(this.url('/api/state'), { headers: this.headers(false), signal: ctrl.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw fail('timeout', name ? tr("{name} didn't answer in time. Make sure it's on and online.", { name }) : tr("Your Holly Computer didn't answer in time. Make sure it's on and online."));
      }
      throw fail('unreachable', name
        ? tr("{name} didn't answer at its address. Make sure it's on and Holly Computer is running there.", { name })
        : tr("Your Holly Computer didn't answer at its address. Make sure it's on and Holly Computer is running there."));
    } finally {
      clearTimeout(t);
    }
    if (res.status === 401) throw fail('unauthorized', tr('This pairing link is no longer valid. Open the latest link printed by Holly Computer.'));
    if (!res.ok) throw fail('http', tr('Holly Computer error {status}', { status: res.status }));
    this.applyState(await res.json());
    this.reachable = true;
    // Only a check that it can be reached: no live updates.
    if (live) this.startEvents();
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
    this.watchForeground();
    let backoff = 1000;
    while (!this.closed) {
      const ctrl = new AbortController();
      this.polling = ctrl;
      try {
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
        this.setReachable(true);
        this.hurry = false;
        backoff = 1000;
        if (data.reset) {
          await this.resync();
          continue;
        }
        for (const e of data.events || []) this.handle(e.topic, e.data);
        this.seq = data.seq;
      } catch (err) {
        if (this.closed) break;
        // Started over because the app came back to the front: straight on.
        if (this.restarted === ctrl) {
          this.restarted = null;
          backoff = 1000;
          continue;
        }
        console.warn('live updates', err.message);
        this.setReachable(false);
        // Holly Computer restarted, so it's at a new address (a quick
        // tunnel's changes each time), or has a new key: the account knows.
        if (this.relocate && Date.now() - this.relocatedAt > 20_000) {
          this.relocatedAt = Date.now();
          const next = await this.relocate().catch(() => null);
          if (next && !this.closed) {
            this.moveTo(next);
            backoff = 1000;
            continue;
          }
        }
        const cutShort = await this.pause(backoff);
        backoff = cutShort ? 1000 : Math.min(backoff * 2, 15000);
      }
    }
    this.polling = null;
    this.eventsRunning = false;
  }

  setReachable(reachable) {
    if (this.reachable === reachable) return;
    this.reachable = reachable;
    this.unreachableSince = reachable ? 0 : Date.now();
    this.emit('reachable');
  }

  /** Waits `ms` before trying again. True when that was cut short because
   * the app came back to the front (watchForeground). */
  pause(ms) {
    if (this.hurry) {
      this.hurry = false;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    }).finally(() => {
      this.wake = null;
    });
  }

  /**
   * A phone stops the app while it's in the background, and with it the
   * connection live updates come through. Back in front (or back online),
   * the app catches up with the computer at once: a poll from before it went
   * away, which may never answer, is dropped for a new one, and a wait to try
   * again is cut short.
   */
  watchForeground() {
    if (typeof document === 'undefined') return;
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;
    const back = (fresh) => {
      if (this.closed) return;
      // Waiting to try again: now. Still finding out a poll failed: no wait
      // when it gets there.
      if (this.wake) this.wake();
      else this.hurry = true;
      if (fresh && this.polling) {
        this.restarted = this.polling;
        this.polling.abort();
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      back(!!hiddenAt && Date.now() - hiddenAt > 3000);
      hiddenAt = 0;
    });
    addEventListener('pageshow', (e) => e.persisted && back(true));
    addEventListener('online', () => back(true));
  }

  /** Talks to Holly Computer at its new address from now on. The next poll
   * finds a new server there and reloads everything (resync). */
  moveTo({ url, token }) {
    this.base = String(url || '').replace(/\/+$/, '');
    this.token = token;
    this.computer.configure({ url: this.base, token });
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
      this.emit('notify', { agent: this.getAgent(data?.agentId), text: data?.text, threadId: data?.threadId, say: data?.say || null });
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
    this.polling?.abort();
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
    const t = this.threads.get(id);
    if (t) {
      this.threads.set(id, { ...t, ...patch });
      this.emit('threads');
      this.emit(`thread:${id}`);
    }
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

// Which Holly Computer this device controls belongs to the Holly Bot account
// that paired it, so another account signing in here never inherits it. Where
// there are no accounts (Wi-Fi links, browser automation), it's per device.
const KEY = 'holly.connection';
const PENDING = 'holly.connection.pending';
const HERE = 'holly.runHere';
let scope = '';

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* storage blocked */ }
}

/** From now on, connections are the signed-in account's. */
export function useConnectionsOf(userId) {
  scope = userId ? `:${userId}` : '';
}

export function savedConnection() {
  return readJson(KEY + scope);
}

/** Saves the computer this device controls, or forgets it (null). Either way
 * a choice to run the bots here (runHere) is over. */
export function saveConnection(conn) {
  writeJson(KEY + scope, conn);
  writeJson(HERE + scope, null);
}

/** This device runs the account's bots itself, and doesn't connect to the
 * account's computer by itself, until it's connected to one again. */
export function runHere() {
  writeJson(KEY + scope, null);
  writeJson(HERE + scope, true);
}

export function runsHere() {
  return !!readJson(HERE + scope);
}

// ----- computers linked to the account -------------------------------------------

/** A linked computer says it's running every five minutes
 * (computer/src/home.mjs); one not heard from for longer than this is off. */
const RUNNING_MS = 12 * 60_000;

/**
 * What a computer linked to the account (convex/devices.ts `list`) is doing:
 * 'running' where this app can reach it; 'hidden', running with no address
 * the app can reach (no --tunnel or --public-url, or its tunnel closed);
 * 'off', stopped or not heard from lately; or 'old', never heard from (a
 * Holly Computer older than 1.8.0, which doesn't say).
 */
export function computerState(device, now = Date.now()) {
  if (!device?.seenAt) return 'old';
  if (device.stoppedAt || now - device.seenAt > RUNNING_MS) return 'off';
  return device.url && device.access ? 'running' : 'hidden';
}

/** How to reach a linked computer that's running where this app can reach it, or null. */
export function computerConnection(device) {
  if (computerState(device) !== 'running') return null;
  return { url: device.url, token: device.access, name: device.name, device: device.id };
}

/** A linked computer's current address, as this app remembers it (tried,
 * or put away): a quick tunnel's changes each time the computer restarts. */
export function addressOf(device) {
  return device ? `${device.id}|${device.url || ''}` : '';
}

/**
 * Whether Holly Computer answers at `url` (its /v1/health, which needs no
 * key, so this is a plain request a browser sends straight away). An
 * address the account has for a computer can still be dead, and then only
 * Cloudflare answers there, with a page a browser won't show to the app.
 */
export async function probeComputer(url, { timeoutMs = 6000 } = {}) {
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(url).replace(/\/+$/, '')}/v1/health`, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok && (await res.json())?.app === 'holly-computer';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connects to the linked computer `device` to check it can be used from
 * here, and gives back how to reach it: its address, or the one the account
 * has for it now (`latest`, which asks the account again) when the first
 * doesn't answer, as happens right after its tunnel changed. Throws with a
 * message to show when neither works.
 */
export async function reachComputer(device, { latest = null } = {}) {
  let conn = computerConnection(device);
  let failure = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!conn) break;
    const remote = new RemoteApp(conn);
    try {
      await remote.connect({ timeoutMs: 10_000, live: false });
      return { ...conn, name: remote.server?.name || conn.name || device.name };
    } catch (err) {
      failure = err;
    }
    const now = attempt === 0 && latest ? computerConnection(await latest().catch(() => null)) : null;
    if (!now || (now.url === conn.url && now.token === conn.token)) break;
    conn = now;
  }
  if (failure) throw failure;
  throw new Error(tr('{name} is off. Start Holly Computer on it, then try again.', { name: device?.name || tr('your Holly Computer') }));
}

/** What sort of device this is, for Holly Computer to say who connected
 * (computer/src/server.mjs hello, deviceName). */
export function deviceKind(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'ipad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'android-phone' : 'android-tablet';
  if (/CrOS/.test(ua)) return 'chromebook';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}

/** A deviceKind in words: "iPhone", "Android phone", "device". */
export function deviceName(kind) {
  const names = {
    iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', chromebook: 'Chromebook',
    'android-phone': tr('Android phone'), 'android-tablet': tr('Android tablet'), windows: tr('Windows PC'), linux: tr('Linux computer'),
  };
  return names[kind] || tr('device');
}

/**
 * Computers the account's devices connect to by themselves: ones a device
 * connected to before (Connect, on the phone, the first time: the account
 * keeps that, convex/devices.ts pair, and so does this device, in case the
 * account can't say yet), and the server that comes with the plan.
 */
const PAIRED = 'holly.pairedComputers';

export function isPaired(device) {
  if (!device) return false;
  if (device.server || device.paired) return true;
  const list = readJson(PAIRED + scope);
  return Array.isArray(list) && list.includes(device.id);
}

/**
 * This device moves to the computer at `conn` because the person chose it
 * (Connect, or picking it in a chat's workspace): it's saved, with what to
 * say once connected there (`hello`: 'first' or 'auto', src/main.js). Moving
 * away from another of their own computers (`from`, a linked computer) on
 * purpose, this device doesn't go back to that one by itself until it
 * restarts, or for twelve hours (declineComputer).
 */
export function chooseComputer(conn, { from = null, hello = 'first' } = {}) {
  if (from?.id && !from.server && from.id !== conn.device) declineComputer(from);
  saveConnection({ ...conn, hello });
}

export function markPaired(device) {
  if (!device?.id || isPaired(device)) return;
  const list = readJson(PAIRED + scope);
  writeJson(PAIRED + scope, [...(Array.isArray(list) ? list : []), device.id].slice(-20));
}

/** Computers this device doesn't connect to by itself: the person said Not
 * now to one, or disconnected this device from it. Until it restarts at a
 * new address, or for twelve hours. */
const DECLINED = 'holly.declinedComputers';
const DECLINE_MS = 12 * 60 * 60_000;

function declinedList() {
  const list = readJson(DECLINED);
  return Array.isArray(list) ? list.filter((d) => Date.now() - d.at < DECLINE_MS) : [];
}

export function declined(device) {
  const key = addressOf(device);
  return declinedList().some((d) => d.key === key);
}

export function declineComputer(device) {
  const key = addressOf(device);
  if (key) writeJson(DECLINED, [...declinedList().filter((d) => d.key !== key), { key, at: Date.now() }].slice(-10));
}

/** Whether `conn` (a saved connection) is the linked computer `device`. */
export function sameComputer(device, conn) {
  if (!device || !conn) return false;
  return device.id === conn.device || (!!conn.name && device.name === conn.name) || (!!device.url && device.url === conn.url);
}

/** A pairing link opened before signing in, held for whoever signs in next (for an hour). */
export function holdConnection(conn) {
  writeJson(PENDING, { conn, at: Date.now() });
}

export function takeHeldConnection() {
  const held = readJson(PENDING);
  writeJson(PENDING, null);
  return held && Date.now() - held.at < 60 * 60 * 1000 ? held.conn : null;
}

/** The connection this device saved before Holly Bot had accounts. */
export function deviceConnection() {
  return readJson(KEY);
}

export function forgetDeviceConnection() {
  writeJson(KEY, null);
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
