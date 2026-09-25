import { DB, range } from './db.js';
import { uid, now, nextSeq, Emitter, normalizeName, truncate } from './util.js';
import { MemoryStore, SHARED_ID } from './memory/store.js';
import { FileStore, isTextPath } from './files.js';
import { RoutineStore, deviceTimeZone } from './routines.js';
import { ProviderHub } from './providers/index.js';
import { ComputerClient } from './computer.js';
import { PluginManager } from './plugins.js';
import { Runtime, finalText, messageText } from './runtime.js';
import { BM25 } from './memory/text.js';
import { SHAPE_KEYS_CORE, COLOR_KEYS_CORE, THINKING_KEYS, TOOL_GROUPS, FOCUS_OPTIONS } from './constants.js';
import { CHIEF, chiefGreeting, chiefOf } from './chief.js';
import { estimateCost } from './pricing.js';
import { BUILTIN_TOOLS } from './tools/index.js';

// App state: the single source of truth the UI renders from. Persists to
// IndexedDB and emits change topics:
//   'agents' | 'threads' | 'settings' | 'runs' | 'activity'
//   'thread:<id>' | 'messages:<threadId>' | 'memory:<agentId>' | 'files:<agentId>' | 'routines'

export const DEFAULT_SETTINGS = {
  profile: { name: '', email: '', about: '' },
  providers: {},
  defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same', effort: '' },
  // Retry once with this provider/model when the main one fails (outage, rate limit, no credit).
  backup: { provider: '', model: '' },
  memory: { auto: true, embeddings: 'auto', contextBudget: 'auto' },
  services: {},
  computer: { url: '', token: '' },
  mcpServers: [],
  skills: [],
  // Ask before risky actions (shell, clicks, MCP, sending email). Off, bots just
  // do them. Replaces `autoReview`, which was on; saved values of it are ignored.
  askFirst: false,
  timeZoneAuto: true,
  timeZone: '',
  notifications: false,
  appearance: 'black',
  language: 'system',
  haptics: true,
  usage: { since: 0, byModel: {} },
  onboarded: false,
};

/** `promise`, or an AbortError as soon as `signal` fires. The work itself
 * carries on (a server call can't be taken back); the caller just stops waiting. */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Stopped', 'AbortError'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** A reply still marked as streaming when nothing is writing it was cut off
 * when the app closed: marks it stopped. True when `m` changed. */
function markInterrupted(m) {
  if (m.status !== 'streaming') return false;
  m.status = 'stopped';
  m.error = null;
  for (const s of m.steps || []) {
    if (!s.endedAt) s.endedAt = now();
    for (const c of s.toolCalls || []) {
      if (!c.result && !c.pending && c.approval?.status !== 'pending') {
        c.status = 'error';
        c.result = { content: 'Interrupted (the app was closed).', isError: true };
      }
    }
  }
  return true;
}

export class App {
  /**
   * @param {object} db   IndexedDB wrapper (browser) or NodeDB (Holly Computer)
   * @param {object} [opts]
   * @param {object} [opts.computer] computer implementation (defaults to the HTTP client for a remote Bot Computer)
   * @param {string} [opts.host] 'browser' | 'computer' — where the bots run
   */
  constructor(db, { computer, host = 'browser' } = {}) {
    this.db = db;
    this.host = host;
    this.viewers = new Map(); // viewer id -> threadId being viewed (remote clients)
    this.events = new Emitter();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.agents = new Map();
    this.threads = new Map();
    this.messageCache = new Map(); // threadId -> Message[] (sorted by seq)
    this.activity = [];
    this.viewingThreadId = null;
    this.tasks = new Map();
    this.pendingTouches = new Set();
    this.touchScheduled = false;

    this.memory = new MemoryStore({ db, getEmbedder: () => this.providers.embedder(), onChange: (id) => this.emit(`memory:${id}`) });
    this.files = new FileStore({ db, onChange: (id) => this.emit(`files:${id}`) });
    this.routines = new RoutineStore({ db, getTimeZone: () => this.timeZone(), onChange: () => this.emit('routines') });
    this.providers = new ProviderHub(this);
    this.computer = computer || new ComputerClient();
    this.plugins = new PluginManager(this);
    this.runtime = new Runtime(this);
  }

  static async create({ dbName = 'holly', db, computer, host } = {}) {
    const app = new App(db || await DB.open(dbName), { computer, host });
    await app.load();
    return app;
  }

  async load() {
    const kv = await this.db.get('kv', 'settings');
    if (kv?.value) this.settings = mergeDeep(structuredClone(DEFAULT_SETTINGS), kv.value);
    // Usage counts are kept apart from the rest of the settings (saveUsageSoon).
    const usage = await this.db.get('kv', 'usage');
    if (usage?.value) this.settings.usage = usage.value;
    for (const a of await this.db.all('agents')) this.agents.set(a.id, a);
    for (const t of await this.db.all('threads')) this.threads.set(t.id, t);
    for (const t of await this.db.all('tasks')) this.tasks.set(t.id, t);
    // Anything that was mid-stream when the app closed is no longer running.
    for (const t of this.threads.values()) {
      if (t.status === 'working') {
        t.status = 'idle';
        await this.db.put('threads', t);
      }
    }
    this.computer.configure(this.settings.computer || {});
  }

  /** Start background services (computer connection, plugins). */
  async start() {
    if (this.computer.configured) this.computer.connect().then(() => this.emit('computer')).catch(() => this.emit('computer'));
    this.plugins.refresh().catch((err) => console.warn('plugins', err));
    this.refreshConnections();
    await this.repairInterruptedMessages();
  }

  /**
   * Run due routines every 30s (and right away). `lock` lets a browser make sure
   * only one tab runs them; Holly Computer runs them 24/7. Storage shared by
   * several devices (an account's) is asked first whether this device is up to
   * date, then for each run, so only one device does it.
   */
  startScheduler({ lock } = {}) {
    if (this.schedulerTimer) return;
    const tick = async () => {
      const run = async () => {
        const due = await this.routines.due();
        if (!due.length || (this.db.fresh && !(await this.db.fresh()))) return;
        for (const r of due) {
          if (this.db.claim && !(await this.db.claim(`routine:${r.id}`, r.nextRunAt))) continue;
          this.runtime.runRoutine(r).catch((err) => console.warn('routine failed', err));
        }
      };
      try {
        if (lock) await lock(run);
        else await run();
      } catch (err) {
        console.warn('scheduler', err);
      }
    };
    this.schedulerKick = tick;
    this.schedulerFirst = setTimeout(tick, 2500);
    this.schedulerTimer = setInterval(tick, 30000);
  }

  stopScheduler() {
    clearTimeout(this.schedulerFirst);
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  async repairInterruptedMessages() {
    // Account storage (src/account/cloud-db.js) would load every chat for
    // this; there each chat is checked as it opens instead (loadMessages).
    if (this.db.cloud) return;
    for (const t of this.threads.values()) {
      const msgs = await this.db.query('messages', 'byThread', range.prefix([t.id]), { direction: 'prev', limit: 4 });
      for (const m of msgs) if (markInterrupted(m)) await this.db.put('messages', m);
    }
  }

  // ----- events -------------------------------------------------------------

  on(topic, fn) {
    return this.events.on(topic, fn);
  }

  emit(topic, payload) {
    this.events.emit(topic, payload);
  }

  emitRuns() {
    this.emit('runs');
  }

  /** Streaming updates: coalesce to one UI update per animation frame. */
  touchMessage(msg) {
    this.pendingTouches.add(msg);
    if (this.touchScheduled) return;
    this.touchScheduled = true;
    const flush = () => {
      this.touchScheduled = false;
      const list = [...this.pendingTouches];
      this.pendingTouches.clear();
      for (const m of list) {
        m.updatedAt = now();
        this.emit(`messages:${m.threadId}`, m);
        this.emit(`message:${m.id}`, m);
      }
    };
    if (typeof requestAnimationFrame === 'function' && !this.hidden()) requestAnimationFrame(flush);
    else setTimeout(flush, 50);
  }

  hidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /** Images/files are inline in this mode; remote mode maps paths to server URLs. */
  assetUrl(path) {
    return path;
  }

  isViewing(threadId) {
    if (this.viewingThreadId === threadId) return true;
    for (const t of this.viewers.values()) if (t === threadId) return true;
    return false;
  }

  setViewing(threadId, viewerId = null) {
    if (viewerId) {
      if (threadId) this.viewers.set(viewerId, threadId);
      else this.viewers.delete(viewerId);
    } else this.viewingThreadId = threadId;
    if (threadId) this.markRead(threadId);
  }

  timeZone() {
    return (!this.settings.timeZoneAuto && this.settings.timeZone) || deviceTimeZone();
  }

  // ----- settings -----------------------------------------------------------

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await this.db.put('kv', { key: 'settings', value: this.settings });
    if (patch.usage) await this.db.put('kv', { key: 'usage', value: this.settings.usage });
    if (patch.computer) this.computer.configure(this.settings.computer);
    this.emit('settings');
  }

  async setProvider(id, patch) {
    const cur = this.settings.providers?.[id] || {};
    await this.saveSettings({ providers: { ...this.settings.providers, [id]: { ...cur, ...patch } } });
  }

  recordUsage(provider, model, usage) {
    if (!usage) return;
    const key = `${provider}:${model}`;
    const byModel = { ...(this.settings.usage?.byModel || {}) };
    const cur = byModel[key] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, images: 0, cost: 0 };
    // Cost is added per call so time-of-day pricing (DeepSeek off-peak) is counted right.
    const callCost = estimateCost(model, usage, now());
    const before = cur.cost != null ? cur.cost : estimateCost(model, cur);
    byModel[key] = {
      input: cur.input + (usage.input || 0),
      output: cur.output + (usage.output || 0),
      cacheRead: cur.cacheRead + (usage.cacheRead || 0),
      cacheWrite: cur.cacheWrite + (usage.cacheWrite || 0),
      calls: cur.calls + (usage.images ? 0 : 1),
      images: (cur.images || 0) + (usage.images || 0),
      cost: callCost == null ? cur.cost : (before || 0) + callCost,
      last: now(),
    };
    this.settings.usage = { since: this.settings.usage?.since || now(), byModel };
    this.saveUsageSoon();
  }

  /** Usage is saved as its own record, so counting a call never writes the
   * settings (keys, profile) back over a newer copy from another device. */
  saveUsageSoon() {
    clearTimeout(this.usageTimer);
    this.usageTimer = setTimeout(() => {
      this.db.put('kv', { key: 'usage', value: this.settings.usage }).catch(() => {});
      this.emit('settings');
    }, 1500);
  }

  // ----- agents -------------------------------------------------------------

  listAgents() {
    return [...this.agents.values()].filter((a) => !a.archived).sort((a, b) => a.createdAt - b.createdAt);
  }

  getAgent(id) {
    return this.agents.get(id) || null;
  }

  findAgent(nameOrId) {
    if (!nameOrId) return null;
    if (this.agents.has(nameOrId)) return this.agents.get(nameOrId);
    const n = normalizeName(nameOrId);
    const list = this.listAgents();
    return list.find((a) => normalizeName(a.name) === n)
      || list.find((a) => normalizeName(a.name).startsWith(n) || n.startsWith(normalizeName(a.name)))
      || null;
  }

  async createAgent(data) {
    const t = now();
    const tools = {};
    for (const [k, v] of Object.entries(TOOL_GROUPS)) tools[k] = v.default;
    const agent = {
      id: uid('bot'),
      name: String(data.name || 'Bot').trim().slice(0, 40),
      shape: SHAPE_KEYS_CORE.includes(data.shape) ? data.shape : SHAPE_KEYS_CORE[Math.floor(Math.random() * SHAPE_KEYS_CORE.length)],
      color: COLOR_KEYS_CORE.includes(data.color) ? data.color : 'green',
      thinking: THINKING_KEYS.includes(data.thinking) ? data.thinking : THINKING_KEYS[Math.floor(Math.random() * THINKING_KEYS.length)],
      description: data.description || '',
      persona: data.persona || '',
      provider: data.provider || '',
      model: data.model || '',
      effort: data.effort || '',
      tools: { ...tools, ...(data.tools || {}) },
      memoryAuto: true,
      core: { persona: '', human: '', notes: '' },
      alwaysAllow: {},
      createdAt: t,
      updatedAt: t,
      createdBy: data.createdBy || 'user',
      memSinceReflection: 0,
      // The Chief Coordinator (src/core/chief.js): one per account.
      ...(data.role === 'chief' && !chiefOf(this) ? { role: 'chief' } : {}),
    };
    this.agents.set(agent.id, agent);
    await this.db.put('agents', agent);
    const thread = await this.ensureDmThread(agent.id);
    if (data.greet !== false) await this.greet(agent, thread);
    this.emit('agents');
    return agent;
  }

  /** The bot's first message: a hello plus the "what should I focus on" card
   * (the Chief Coordinator's: what should the team take on first). */
  async greet(agent, thread) {
    const callId = `onboard_${agent.id}`;
    const chief = agent.role === 'chief';
    const text = chief ? chiefGreeting(agent.name) : `Hey — I'm ${agent.name}. Ready whenever you are.\n\nWhat do you want me helping with most?`;
    const question = chief ? CHIEF.question : 'What should I focus on first?';
    const subtitle = chief ? CHIEF.subtitle : "Pick whatever's most useful — we can expand from there.";
    const options = chief ? CHIEF.focus : FOCUS_OPTIONS;
    await this.addMessage({
      threadId: thread.id,
      authorType: 'agent',
      authorId: agent.id,
      status: 'waiting',
      local: true,
      turnId: `greet_${agent.id}`,
      steps: [{
        id: uid('stp'),
        text,
        toolCalls: [{
          id: callId,
          name: 'ask_user',
          local: true,
          args: { question, subtitle, options },
          status: 'waiting',
          pending: { kind: 'question', question, subtitle, options, local: true },
        }],
        endedAt: now(),
      }],
    });
    await this.updateThread(thread.id, { preview: { kind: 'normal', text: text.split('\n')[0], authorId: agent.id, at: now() }, unread: false });
  }

  async updateAgent(id, patch) {
    const a = this.agents.get(id);
    if (!a) throw new Error('Bot not found');
    const next = { ...a, ...patch, updatedAt: now() };
    this.agents.set(id, next);
    await this.db.put('agents', next);
    this.emit('agents');
    this.emit(`agent:${id}`);
    const dm = this.threads.get(`dm_${id}`);
    if (dm && patch.name) await this.updateThread(dm.id, { title: patch.name });
    return next;
  }

  async deleteAgent(id) {
    const a = this.agents.get(id);
    if (!a) return;
    for (const t of [...this.threads.values()]) {
      if (t.agentIds.includes(id) && (t.kind !== 'group' || t.agentIds.length <= 1)) await this.deleteThread(t.id);
      else if (t.agentIds.includes(id)) await this.updateThread(t.id, { agentIds: t.agentIds.filter((x) => x !== id) });
    }
    await this.memory.clear(id);
    await this.files.clear(id);
    await this.routines.removeForAgent(id);
    await this.db.deleteWhere('activity', 'byAgent', range.prefix([id]));
    this.agents.delete(id);
    await this.db.delete('agents', id);
    this.emit('agents');
    this.emit('routines');
  }

  // ----- threads ------------------------------------------------------------

  listThreads({ includeAgentChannels = false } = {}) {
    return [...this.threads.values()]
      .filter((t) => includeAgentChannels || t.kind !== 'agents')
      .sort((a, b) => (b.preview?.at || b.updatedAt) - (a.preview?.at || a.updatedAt));
  }

  getThread(id) {
    return this.threads.get(id) || null;
  }

  async ensureDmThread(agentId) {
    const id = `dm_${agentId}`;
    if (this.threads.has(id)) return this.threads.get(id);
    const agent = this.agents.get(agentId);
    const t = { id, kind: 'dm', title: agent?.name || 'Bot', agentIds: [agentId], createdAt: now(), updatedAt: now(), status: 'idle', unread: false, summary: '', summaryUpToSeq: 0 };
    this.threads.set(id, t);
    await this.db.put('threads', t);
    this.emit('threads');
    return t;
  }

  async ensureAgentThread(a, b) {
    const [x, y] = [a, b].sort();
    const id = `ag_${x}_${y}`;
    if (this.threads.has(id)) return this.threads.get(id);
    const t = {
      id, kind: 'agents', title: `${this.getAgent(x)?.name} ↔ ${this.getAgent(y)?.name}`, agentIds: [x, y],
      createdAt: now(), updatedAt: now(), status: 'idle', unread: false, summary: '', summaryUpToSeq: 0,
    };
    this.threads.set(id, t);
    await this.db.put('threads', t);
    this.emit('threads');
    return t;
  }

  async createGroup({ title, agentIds, mode = 'auto' }) {
    const t = {
      id: uid('grp'), kind: 'group', title: String(title || '').trim() || agentIds.map((id) => this.getAgent(id)?.name).join(', '),
      agentIds: [...agentIds], mode, createdAt: now(), updatedAt: now(), status: 'idle', unread: false, summary: '', summaryUpToSeq: 0,
    };
    this.threads.set(t.id, t);
    await this.db.put('threads', t);
    await this.addMessage({
      threadId: t.id, authorType: 'system', authorId: 'system',
      parts: [{ type: 'text', text: `Group created with ${agentIds.map((id) => this.getAgent(id)?.name).join(', ')}. Mention a bot with @Name to ask it directly.` }],
    });
    await this.updateThread(t.id, { preview: { kind: 'normal', text: 'Group created', at: now() } });
    this.emit('threads');
    return t;
  }

  async updateThread(id, patch) {
    const t = this.threads.get(id);
    if (!t) return null;
    const next = { ...t, ...patch, updatedAt: now() };
    this.threads.set(id, next);
    await this.db.put('threads', next);
    this.emit('threads');
    this.emit(`thread:${id}`);
    return next;
  }

  async markRead(id) {
    const t = this.threads.get(id);
    if (t?.unread) await this.updateThread(id, { unread: false });
  }

  async deleteThread(id) {
    this.runtime.stop(id);
    await this.db.deleteWhere('messages', 'byThread', range.prefix([id]));
    this.messageCache.delete(id);
    this.threads.delete(id);
    await this.db.delete('threads', id);
    this.emit('threads');
  }

  /** Clear a chat's messages (the bot keeps its long-term memory). */
  async clearThread(id) {
    this.runtime.stop(id);
    await this.db.deleteWhere('messages', 'byThread', range.prefix([id]));
    this.messageCache.set(id, []);
    await this.updateThread(id, { summary: '', summaryUpToSeq: 0, preview: { kind: 'normal', text: 'Chat cleared', at: now() }, status: 'idle' });
    this.emit(`messages:${id}`);
  }

  // ----- messages -----------------------------------------------------------

  async loadMessages(threadId) {
    if (this.messageCache.has(threadId)) return this.messageCache.get(threadId);
    const rows = await this.db.query('messages', 'byThread', range.prefix([threadId]));
    if (this.db.cloud && !this.runtime.isThreadBusy(threadId)) {
      for (const m of rows.slice(-4)) if (markInterrupted(m)) await this.db.put('messages', m);
    }
    this.messageCache.set(threadId, rows);
    return rows;
  }

  async getMessage(id) {
    for (const list of this.messageCache.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    const m = await this.db.get('messages', id);
    if (m) {
      const list = await this.loadMessages(m.threadId);
      return list.find((x) => x.id === id) || m;
    }
    return null;
  }

  async addMessage(data) {
    const t = now();
    const m = { id: uid('msg'), seq: nextSeq(), createdAt: t, updatedAt: t, parts: [], ...data };
    if (m.authorType === 'agent' && !m.steps) m.steps = [];
    const list = await this.loadMessages(m.threadId);
    list.push(m);
    list.sort((a, b) => a.seq - b.seq);
    await this.db.put('messages', m);
    if (m.authorType === 'user') {
      const text = messageText(m) || (m.parts.some((p) => p.type === 'image') ? 'Sent a photo' : 'Sent a file');
      await this.updateThread(m.threadId, { preview: { kind: 'normal', text: truncate(text, 140), authorId: 'user', at: t }, unread: false });
    }
    this.emit(`messages:${m.threadId}`, m);
    return m;
  }

  async saveMessage(m) {
    m.updatedAt = now();
    await this.db.put('messages', stripRuntime(m));
    this.emit(`messages:${m.threadId}`, m);
    this.emit(`message:${m.id}`, m);
  }

  async deleteMessage(id) {
    const m = await this.getMessage(id);
    if (!m) return;
    const list = this.messageCache.get(m.threadId);
    if (list) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    }
    await this.db.delete('messages', id);
    this.emit(`messages:${m.threadId}`, { id, threadId: m.threadId, deleted: true });
  }

  /** User message parts prepared for a model: images as base64, text files inlined. */
  async partsForModel(m) {
    const out = [];
    for (const p of m.parts || []) {
      if (p.type === 'text') out.push({ type: 'text', text: p.text });
      else if (p.type === 'image') {
        const data = p.data || (p.dataUrl ? p.dataUrl.split(',')[1] : null);
        if (data) out.push({ type: 'image', mime: p.mime || 'image/jpeg', data });
      } else if (p.type === 'file') {
        const f = p.fileId ? await this.files.getById(p.fileId) : null;
        let text = null;
        let data = null;
        if (f?.text != null) text = f.text;
        else if (f?.blob && isTextPath(f.path, f.mime)) text = await f.blob.text();
        else if (f?.blob && f.mime === 'application/pdf' && f.size < 20 * 1024 * 1024) data = await blobToBase64(f.blob);
        out.push({ type: 'document', name: p.name, mime: p.mime, text: text != null ? truncate(text, 120000) : null, data, note: `saved to your drive as ${f?.path || p.name}` });
        if (f) out.push({ type: 'text', text: `(Attached file "${p.name}" is also saved in your drive at ${f.path}.)` });
      }
    }
    return out;
  }

  /** Run memory reflection + profile refresh for a bot now. Returns the number of new insights. */
  async reflectNow(agentId) {
    const { reflect, synthesizeProfile } = await import('./memory/extract.js');
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('Bot not found');
    const llm = (req) => this.providers.complete({ agent, purpose: 'memory', ...req });
    const top = (await this.memory.search(agentId, '', { limit: 40, touch: false })).map((r) => r.memory);
    if (top.length < 3) throw new Error('Needs a few more memories first.');
    const insights = await reflect({ llm, agentName: agent.name, memories: top.map((m) => ({ memory: m })) });
    for (const ins of insights) await this.memory.add(agentId, { text: ins.text, type: 'reflection', importance: ins.importance, source: { kind: 'reflection' } });
    const profile = await synthesizeProfile({ llm, agentName: agent.name, currentProfile: agent.core?.human || '', memories: top.filter((m) => m.type !== 'reflection').map((m) => ({ memory: m })) });
    if (profile) await this.updateAgent(agentId, { core: { ...(agent.core || {}), human: profile }, memSinceReflection: 0, lastReflectionAt: now() });
    return insights.length;
  }

  // ----- search over past conversations ------------------------------------

  async searchHistory(agentId, query, { limit = 8 } = {}) {
    const threads = [...this.threads.values()].filter((t) => t.agentIds.includes(agentId));
    const docs = [];
    for (const t of threads) {
      const rows = await this.db.query('messages', 'byThread', range.prefix([t.id]));
      for (const m of rows) {
        const text = m.authorType === 'agent' ? finalText(m) : messageText(m);
        if (!text) continue;
        const speaker = m.authorType === 'user' ? (this.settings.profile?.name || 'User') : m.authorType === 'system' ? 'System' : this.getAgent(m.authorId)?.name || 'Bot';
        docs.push({ id: m.id, text, speaker, createdAt: m.createdAt, threadTitle: t.kind === 'dm' ? `Chat with ${this.getAgent(t.agentIds[0])?.name || 'bot'}` : t.title });
      }
    }
    if (!docs.length) return [];
    const scores = new BM25(docs).search(query);
    const byId = new Map(docs.map((d) => [d.id, d]));
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => byId.get(id));
  }

  // ----- tasks & activity -----------------------------------------------------

  async saveTask(task) {
    this.tasks.set(task.id, task);
    await this.db.put('tasks', task);
    this.emit('tasks');
    return task;
  }

  logActivity(agentId, entry) {
    const row = { id: uid('act'), agentId, createdAt: now(), ...entry };
    this.activity.unshift(row);
    if (this.activity.length > 300) this.activity.length = 300;
    this.db.put('activity', row).catch(() => {});
    this.emit('activity', row);
  }

  async loadActivity(agentId, limit = 100) {
    return this.db.query('activity', 'byAgent', range.prefix([agentId]), { direction: 'prev', limit });
  }

  /** Look up a tool by name even if it is not in the current list (e.g. resumed after settings changed). */
  findToolAnywhere(name, agent) {
    return BUILTIN_TOOLS.find((t) => t.name === name) || this.plugins.toolsFor(agent).find((t) => t.name === name) || null;
  }

  // ----- connected services (Gmail, Outlook, GitHub) -----------------------------

  /** The account's connection to a service ({service, account, via}), or null.
   * Only storage that is the account's (CloudDB) has any (convex/connectors.ts). */
  connection(service) {
    return this.connections?.find((c) => c.service === service) || null;
  }

  /** Loads the account's connections, when the ones held are older than
   * `maxAge`. Never throws, and waits at most a few seconds: a turn goes ahead
   * with what's known. */
  refreshConnections({ maxAge = 0 } = {}) {
    if (!this.db?.cloud || typeof this.db.call !== 'function') return Promise.resolve([]);
    if (maxAge && this.connectionsAt && Date.now() - this.connectionsAt < maxAge) return Promise.resolve(this.connections);
    if (!this.connectionsLoading) {
      this.connectionsLoading = this.db.call('query', 'connectors:list')
        .then((list) => {
          const changed = JSON.stringify(list) !== JSON.stringify(this.connections || []);
          this.connections = list;
          this.connectionsAt = Date.now();
          if (changed) this.emit('connections');
        })
        .catch((err) => console.warn('connections', err?.message || err))
        .finally(() => { this.connectionsLoading = null; });
    }
    let timer;
    const waited = new Promise((resolve) => { timer = setTimeout(resolve, 4000); });
    return Promise.race([this.connectionsLoading, waited]).then(() => {
      clearTimeout(timer);
      return this.connections || [];
    });
  }

  /** Asks the server to do `op` on a connected service for a bot (convex/connectors.ts `run`). */
  async connector(service, op, args = {}, { signal } = {}) {
    if (!this.db?.cloud || typeof this.db.call !== 'function') throw new Error('Connected accounts need you signed in to your Holly Bot account.');
    const call = this.db.call('action', 'connectors:run', { service, op, args });
    try {
      return await (signal ? untilAborted(call, signal) : call);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // A ConvexError carries the server's own words in `data`.
      const text = typeof err?.data === 'string' ? err.data : '';
      if (/isn't connected|needs connecting again/.test(text)) this.refreshConnections();
      throw text ? new Error(text) : err;
    }
  }

  // ----- notifications ------------------------------------------------------

  notify(agent, text, threadId) {
    this.emit('notify', { agent, agentId: agent?.id, text, threadId });
  }

  // ----- backup ---------------------------------------------------------------

  async exportData({ includeKeys = false } = {}) {
    return this.db.exportAll({ includeKeys });
  }

  async importData(data) {
    await this.db.importAll(data, { replace: true });
    this.agents.clear();
    this.threads.clear();
    this.messageCache.clear();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    await this.load();
    this.emit('agents');
    this.emit('threads');
    this.emit('settings');
  }

  async resetAll() {
    this.runtime.stopAll();
    for (const s of ['kv', 'agents', 'threads', 'messages', 'memories', 'files', 'routines', 'tasks', 'activity']) await this.db.clear(s);
    this.agents.clear();
    this.threads.clear();
    this.messageCache.clear();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.emit('agents');
    this.emit('threads');
    this.emit('settings');
  }
}

export { SHARED_ID };

function stripRuntime(m) {
  // Messages are plain data; nothing to strip today, but keep a single place for it.
  return m;
}

function mergeDeep(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) base[k] = mergeDeep(base[k], v);
    else base[k] = v;
  }
  return base;
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
