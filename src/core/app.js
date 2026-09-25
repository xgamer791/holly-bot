import { DB, range } from './db.js';
import { uid, now, nextSeq, Emitter, normalizeName, truncate, extractJson, callName } from './util.js';
import { MemoryStore, SHARED_ID, USER_ID } from './memory/store.js';
import { FileStore, isTextPath } from './files.js';
import { RoutineStore, deviceTimeZone } from './routines.js';
import { ProviderHub } from './providers/index.js';
import { ComputerClient } from './computer.js';
import { PluginManager } from './plugins.js';
import { Runtime, finalText, messageText } from './runtime.js';
import { BM25 } from './memory/text.js';
import { SHAPE_KEYS_CORE, COLOR_KEYS_CORE, THINKING_KEYS, TOOL_GROUPS, FOCUS_OPTIONS } from './constants.js';
import { CHIEF, chiefGreeting, chiefOf } from './chief.js';
import { firstWords, languageName, phrase, spoken } from './i18n.js';
import { estimateCost } from './pricing.js';
import { BUILTIN_TOOLS } from './tools/index.js';
import { BRIEF_PROMPT, briefInput } from './brief.js';

// App state: the single source of truth the UI renders from. Persists to
// IndexedDB and emits change topics:
//   'agents' | 'threads' | 'settings' | 'runs' | 'activity'
//   'thread:<id>' | 'messages:<threadId>' | 'memory:<agentId>' | 'files:<agentId>' | 'routines'

export const DEFAULT_SETTINGS = {
  // The user: their name, and what the bots call them (callMe; noName: not by
  // name), as they said in their chats (src/core/runtime.js).
  profile: { name: '', email: '', about: '', callMe: '', noName: false },
  providers: {},
  defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same', effort: '' },
  // Retry once with this provider/model when the main one fails (outage, rate limit, no credit).
  backup: { provider: '', model: '' },
  // learnUser: bots learn about the user (src/core/memory/store.js USER_ID);
  // fromEmail: from the emails they read for them too. Both as the user says
  // in their chats (src/core/runtime.js).
  memory: { auto: true, embeddings: 'auto', contextBudget: 'auto', learnUser: true, fromEmail: false },
  services: {},
  computer: { url: '', token: '' },
  mcpServers: [],
  skills: [],
  // Ask before risky actions (shell, clicks, MCP, sending email). Off, bots just
  // do them. Replaces `autoReview`, which was on; saved values of it are ignored.
  askFirst: false,
  // The person's time zone, as the app last saw it on their device (src/main.js):
  // what bots on Holly Computer go by (timeZone()).
  timeZone: '',
  notifications: false,
  appearance: 'black',
  // Settings → Language: 'system', 'en', 'es' or 'zh' (src/ui/i18n.js). And
  // the language the app was last shown in, which bots write in (src/main.js).
  language: 'system',
  uiLanguage: '',
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

/** A phrase as a message part or preview keeps it: its English as `text`,
 * and the phrase as `say`, for the app to show translated. */
function shown(p) {
  const { text, say } = spoken(p);
  return { text, say };
}

/** How long creating a bot waits for its focus options before using the usual ones. */
const FOCUS_WAIT_MS = 8000;

const FOCUS_PROMPT = 'Someone just made an AI assistant bot and named it. From its name (and its job or instructions, when given), '
  + 'work out what they made it for, and write the four things it should offer to help with first, most likely first. '
  + 'Each is a short option on a menu, 2 to 4 words, like "Fix bugs in my code" or "Plan this week\'s meals". '
  + 'When the name doesn\'t point anywhere in particular (a person\'s name, a made-up word), give four broadly useful options. '
  + 'Reply with JSON only: {"options":["…","…","…","…"]}';

/** The model's focus options, tidied: no numbering or end punctuation, short,
 * no repeats, and no "Something else" (`other`, as the card adds it). Four
 * at most. */
function focusChoices(list, other = 'Something else') {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    const text = item.trim().replace(/^(?:[A-Ea-e1-9][.)]|[-•*])\s+/, '').replace(/[.!。！]+$/, '').trim();
    if (!text || text.length > 40 || /^something else$/i.test(text) || text.toLowerCase() === other.toLowerCase()) continue;
    if (out.some((o) => o.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, 4);
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

    this.memory = new MemoryStore({
      db,
      getEmbedder: () => this.providers.embedder(),
      onChange: (id) => {
        if (id === USER_ID) this.loadUserFacts().catch(() => {});
        this.emit(`memory:${id}`);
      },
    });
    /** What the bots know about the user (USER_ID), for their prompts (src/core/prompts.js). */
    this.userFacts = [];
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
    await this.loadUserFacts();
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
    this.refreshCredits();
    this.moveUserFacts().catch((err) => console.warn('about you', err));
    // Bots given a job before briefings (or whose briefing didn't come through) get one now, once the AI is ready.
    setTimeout(() => this.briefAll().catch((err) => console.warn('briefing', err)), 10000);
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

  /** The person's time zone: this device's, where the bots run in the app.
   * Holly Computer goes by the one the app last saw on the person's own
   * device (settings.timeZone), and its own until then. */
  timeZone() {
    return (this.host === 'computer' && this.settings.timeZone) || deviceTimeZone();
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
    // Its briefing, from the job the user gave it, while it says hello.
    this.briefSoon(agent.id);
    const thread = await this.ensureDmThread(agent.id);
    if (data.greet !== false) await this.greet(agent, thread);
    this.emit('agents');
    return agent;
  }

  /** The bot's first message: a hello plus the "what should I focus on" card,
   * with options that fit its name (focusOptions). The Chief Coordinator's
   * asks what the team should take on first. In the language the app was
   * last shown in (settings.uiLanguage). */
  async greet(agent, thread) {
    const callId = `onboard_${agent.id}`;
    const chief = agent.role === 'chief';
    const lang = this.settings.uiLanguage || 'en';
    const say = (text, vars) => firstWords(lang, text, vars);
    // By name, when the bots know what to call the user.
    const user = callName(this.settings.profile);
    const text = chief ? chiefGreeting(agent.name, lang, user)
      : user ? say("Hey {user} — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?", { name: agent.name, user })
      : say("Hey — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?", { name: agent.name });
    const question = say(chief ? CHIEF.question : 'What should I focus on first?');
    const subtitle = say(chief ? CHIEF.subtitle : "Pick whatever's most useful — we can expand from there.");
    const options = chief ? CHIEF.focus.map((o) => say(o)) : await this.focusOptions(agent);
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

  /**
   * What a new bot offers to start on: four options the AI picks from its
   * name (and its job, when it has one), then "Something else",
   * in the app's language. The usual FOCUS_OPTIONS without an API key, or
   * without a usable answer within a few seconds.
   */
  async focusOptions(agent) {
    const lang = this.settings.uiLanguage || 'en';
    const say = (text) => firstWords(lang, text);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FOCUS_WAIT_MS);
    try {
      const out = await this.providers.complete({
        agent,
        system: lang === 'en' ? FOCUS_PROMPT : `${FOCUS_PROMPT} Write the options in ${languageName(lang)}.`,
        prompt: [
          `Name: ${agent.name}`,
          agent.description && `Job: ${truncate(agent.description, 1000)}`,
          agent.persona && `Instructions: ${truncate(agent.persona, 600)}`,
        ].filter(Boolean).join('\n'),
        json: true,
        maxTokens: 800,
        signal: ctrl.signal,
      });
      const parsed = extractJson(out);
      const picked = focusChoices(Array.isArray(parsed) ? parsed : parsed?.options, say('Something else'));
      if (picked.length >= 3) return [...picked, say('Something else')];
    } catch (err) {
      if (err?.kind !== 'no_key') console.warn('focus options', err?.message || err);
    } finally {
      clearTimeout(timer);
    }
    return FOCUS_OPTIONS.map(say);
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
    // A new job: a new briefing.
    if ('description' in patch && patch.description !== a.description) this.briefSoon(id);
    return next;
  }

  // ----- a bot's briefing on its job (src/core/brief.js) -------------------------

  /** Whether a bot's briefing is missing, or was written for another version
   * of its job. The Chief Coordinator has its own instructions (src/core/chief.js). */
  needsBrief(agent) {
    return !!agent && agent.role !== 'chief' && !!agent.description?.trim() && agent.briefFor !== agent.description;
  }

  /**
   * Has Holly Bot's AI read a bot's job (its description, in the user's
   * words) and write it a briefing, in the background. Returns the work in
   * progress for the job as it is now (null when there's none to do).
   */
  briefSoon(agentId) {
    const agent = this.getAgent(agentId);
    if (!this.needsBrief(agent)) return null;
    this.briefing ||= new Map();
    const job = agent.description;
    const current = this.briefing.get(agentId);
    if (current?.job === job) return current.work;
    const entry = { job };
    this.briefing.set(agentId, entry);
    entry.work = (async () => {
      try {
        const brief = (await this.providers.complete({ agent, purpose: 'memory', system: BRIEF_PROMPT, prompt: briefInput(agent), maxTokens: 900 })).trim();
        // Only if its job is still what was read.
        if (brief && this.getAgent(agentId)?.description === job) await this.updateAgent(agentId, { brief: truncate(brief, 3000), briefFor: job });
      } catch (err) {
        if (err?.kind !== 'no_key') console.warn('briefing', err?.message || err);
      } finally {
        if (this.briefing.get(agentId) === entry) this.briefing.delete(agentId);
      }
    })();
    return entry.work;
  }

  /** Briefs, one at a time, the bots whose briefing is missing or was
   * written for an older version of their job. */
  async briefAll() {
    for (const agent of this.listAgents()) if (this.needsBrief(agent)) await this.briefSoon(agent.id);
  }

  /** Waits (up to `waitMs`) for a bot's briefing, starting it if it's due:
   * its first reply after a new job comes with it. */
  async briefed(agentId, waitMs = 8000) {
    const work = this.briefSoon(agentId);
    if (!work) return;
    let timer;
    await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
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
      parts: [{ type: 'text', ...shown(phrase('Group created with {names}. Mention a bot with @Name to ask it directly.', { names: agentIds.map((id) => this.getAgent(id)?.name).join(', ') })) }],
    });
    await this.updateThread(t.id, { preview: { kind: 'normal', ...shown(phrase('Group created')), at: now() } });
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
    await this.updateThread(id, { summary: '', summaryUpToSeq: 0, preview: { kind: 'normal', ...shown(phrase('Chat cleared')), at: now() }, status: 'idle' });
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

  // ----- what the bots know about the user ----------------------------------

  /** Loads what the bots know about the user, for their prompts. */
  async loadUserFacts() {
    this.userFacts = await this.memory.list(USER_ID);
    return this.userFacts;
  }

  /** The state of the notebook about the user in this storage: when it was
   * filled from the bots' own memories, and last reflected on. */
  async userNotebook(patch) {
    const state = (await this.db.get('kv', 'aboutUser'))?.value || {};
    if (!patch) return state;
    const next = { ...state, ...patch };
    await this.db.put('kv', { key: 'aboutUser', value: next });
    return next;
  }

  /**
   * Once per storage: what each bot had learned about the user themself
   * before the bots shared it (its facts, preferences and people that are
   * about the user: "User's…") moves to what they all know, so every bot
   * knows it. Returns how many moved.
   */
  async moveUserFacts() {
    if ((await this.userNotebook()).movedAt) return 0;
    let moved = 0;
    for (const agent of [...this.agents.values()]) {
      for (const m of await this.memory.list(agent.id)) {
        if (!['fact', 'preference', 'person'].includes(m.type) || !/^(the )?user(['’]s)?\b/i.test(m.text)) continue;
        await this.memory.add(USER_ID, { text: m.text, type: m.type, importance: m.importance, tags: m.tags || [], pinned: !!m.pinned, source: { kind: 'moved', agentId: agent.id } });
        await this.memory.remove(m.id);
        moved++;
      }
    }
    await this.userNotebook({ movedAt: now() });
    return moved;
  }

  /**
   * After a dozen new facts about the user, a reflection on them: patterns
   * that several facts show (tastes, habits, routines), saved as insights
   * every bot sees. Returns how many.
   */
  async reflectOnUser() {
    if (this.reflectingOnUser) return 0;
    this.reflectingOnUser = true;
    try {
      const facts = (await this.memory.list(USER_ID)).filter((m) => m.type !== 'reflection');
      const state = await this.userNotebook();
      if (facts.filter((m) => m.createdAt > (state.reflectedAt || 0)).length < 12) return 0;
      await this.userNotebook({ reflectedAt: now() });
      const { reflect } = await import('./memory/extract.js');
      const llm = (req) => this.providers.complete({ agent: null, purpose: 'memory', ...req });
      const top = facts.sort((a, b) => (b.importance || 5) - (a.importance || 5) || b.updatedAt - a.updatedAt).slice(0, 40);
      const insights = await reflect({ llm, agentName: 'Holly Bot', memories: top.map((m) => ({ memory: m })) });
      for (const ins of insights) await this.memory.add(USER_ID, { text: ins.text, type: 'reflection', importance: ins.importance, source: { kind: 'reflection' } });
      return insights.length;
    } finally {
      this.reflectingOnUser = false;
    }
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

  /** Adds a line to a bot's activity. `entry.title` can be a phrase
   * (src/core/i18n.js): the row keeps the English, and the phrase as `say`. */
  logActivity(agentId, entry) {
    const { text, say } = spoken(entry.title);
    const row = { id: uid('act'), agentId, createdAt: now(), ...entry, title: text, ...(say ? { say } : {}) };
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

  // ----- AI credits -------------------------------------------------------------

  /** This month's AI credits (convex/credits.ts `mine`): what the plan gives,
   * what's left and when they refill, and `ready`, whether Holly Bot's server
   * can run its AI; null without a subscription. Loaded like connections:
   * when what's held is older than `maxAge`, never throwing, and waiting at
   * most a few seconds. Only storage that is the account's has credits. */
  refreshCredits({ maxAge = 0 } = {}) {
    if (!this.db?.cloud || typeof this.db.call !== 'function') return Promise.resolve(null);
    if (maxAge && this.creditsAt && Date.now() - this.creditsAt < maxAge) return Promise.resolve(this.credits);
    if (!this.creditsLoading) {
      this.creditsLoading = this.db.call('query', 'credits:mine')
        .then((credits) => {
          this.credits = credits;
          this.creditsAt = Date.now();
          this.emit('credits');
        })
        .catch((err) => console.warn('credits', err?.message || err))
        .finally(() => { this.creditsLoading = null; });
    }
    let timer;
    const waited = new Promise((resolve) => { timer = setTimeout(resolve, 4000); });
    return Promise.race([this.creditsLoading, waited]).then(() => {
      clearTimeout(timer);
      return this.credits ?? null;
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

  /** `say`: the phrase for `text`, to show it translated (src/core/i18n.js). */
  notify(agent, text, threadId, say = null) {
    this.emit('notify', { agent, agentId: agent?.id, text, threadId, ...(say ? { say } : {}) });
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
