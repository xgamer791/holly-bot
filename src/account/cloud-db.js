import { SCHEMA, DB } from '../core/db.js';

// The app's storage on Holly Bot's Convex backend (convex/data.ts), with the
// same interface as the browser's IndexedDB wrapper (src/core/db.js) and Holly
// Computer's NodeDB, so the app core runs on it unchanged. Everything belongs to
// the signed-in account, and the server only ever hands out that account's rows.
// It runs in the app (src/main.js) and in Holly Bot Computer once it is linked to
// the account (computer/src/account.mjs), each with its own session.
//
// Reads come from memory. The small stores (settings, bots, chats, routines,
// tasks) load when the app opens; messages, memories, files and activity load a
// chat or a bot at a time, the first time the app asks for one.
//
// Writes land in memory at once and in an outbox on this device (IndexedDB in
// the browser, files on Holly Bot Computer; one per account), then go to the
// server in order and in batches, retried through
// network drops. What the outbox still holds when the app closes is sent the next
// time the same account opens it. A file's contents go to Convex file storage,
// and so does a record too big for one database document.
//
// Another device signed in to the same account can change it meanwhile. The
// server counts every write, so this one notices (at each write, when the app
// comes back to the front, and every minute while it's open) and reports it
// through `onStale`; the app then offers to reload (src/main.js). Routines check first
// and claim each run, so two devices never both run one.

/** Stores loaded a group at a time, and the field that names the group. */
const GROUP = { messages: 'threadId', memories: 'agentId', files: 'agentId', activity: 'agentId' };
/** Order within a group, for "the newest few" without loading all of it. */
const SORT = { messages: 'seq', activity: 'createdAt' };
const EAGER = Object.keys(SCHEMA).filter((store) => !GROUP[store]);
/** JSON longer than this goes to file storage (the server takes up to 900k). */
const MAX_DATA = 800_000;
/** A text field longer than this (a big text file) is kept in file storage
 * too, so loading a bot's files for a listing doesn't download it. */
const BIG_TEXT = 100_000;
const BATCH_OPS = 32;
const BATCH_BYTES = 3_000_000;
const PAGE = 100;
/** How often an open app asks whether another device changed the account. */
const CHECK_EVERY = 60_000;
/** How often changes are offered again while the subscription isn't active. */
const INACTIVE_WAIT = 5 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The server turned a call down because the account's subscription isn't
 * active (convex/lib/subscription.ts). It keeps the account's data, and
 * changes wait here until the subscription is active again. */
export const inactive = (err) => /active subscription/i.test(err?.message || '');
const idOf = (store, key) => `${store}\n${key}`;
const keyOf = (store, value) => value?.[SCHEMA[store].keyPath];
const isNetworkError = (err) => err?.name === 'TypeError' || /network|failed to fetch|load failed|fetch failed/i.test(err?.message || '');

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Holly Bot's storage answered ${res.status}`);
  return res;
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A copy the app can change freely. Blobs can't change, so they're shared,
 * which also lets rewriting the same file skip uploading it again. */
function copy(value) {
  if (!value || typeof value !== 'object') return value;
  const blobs = {};
  const rest = {};
  for (const [k, v] of Object.entries(value)) (v instanceof Blob ? blobs : rest)[k] = v;
  return Object.assign(structuredClone(rest), blobs);
}

// ----- keys and indexes, as IndexedDB orders and matches them ----------------

function typeRank(k) {
  if (typeof k === 'number') return 1;
  if (k instanceof Date) return 2;
  if (typeof k === 'string') return 3;
  if (Array.isArray(k)) return 5;
  return 4;
}

function compareKeys(a, b) {
  const ta = typeRank(a);
  const tb = typeRank(b);
  if (ta !== tb) return ta - tb;
  if (ta === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (ta === 2) return a.getTime() - b.getTime();
  return a < b ? -1 : a > b ? 1 : 0;
}

function pathOf(store, index) {
  const spec = SCHEMA[store].indexes?.[index];
  return typeof spec === 'string' || Array.isArray(spec) ? spec : spec?.keyPath;
}

function indexKey(path, value) {
  if (Array.isArray(path)) {
    const parts = path.map((p) => value?.[p]);
    return parts.some((p) => p === undefined || p === null) ? undefined : parts;
  }
  return value?.[path];
}

function inRange(range, key) {
  if (range === undefined || range === null) return true;
  if (range instanceof IDBKeyRange) {
    try {
      return range.includes(key);
    } catch {
      return false;
    }
  }
  return compareKeys(key, range) === 0;
}

/** The chat or bot a query is about, when it names exactly one. */
function groupOf(store, index, range) {
  const field = GROUP[store];
  if (!field || !index || range === undefined || range === null) return undefined;
  const path = pathOf(store, index);
  const compound = Array.isArray(path);
  if ((compound ? path[0] : path) !== field) return undefined;
  const first = (k) => (compound ? (Array.isArray(k) ? k[0] : undefined) : k);
  if (range instanceof IDBKeyRange) {
    const lower = first(range.lower);
    return lower !== undefined && lower === first(range.upper) ? lower : undefined;
  }
  return first(range);
}

/** `range.prefix([group])` (src/core/db.js): all of one group, in order. */
function wholeGroup(range) {
  return range instanceof IDBKeyRange && Array.isArray(range.lower) && range.lower.length === 1
    && Array.isArray(range.upper) && range.upper.length === 2 && Array.isArray(range.upper[1]);
}

// ----- the outbox --------------------------------------------------------------

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Changes not on the server yet, kept on this device so closing the app
 * doesn't lose them. Falls back to memory where IndexedDB is unavailable.
 * Holly Bot Computer keeps its own in files, with the same methods
 * (computer/src/outbox.mjs). */
class Outbox {
  static async open(name) {
    const box = new Outbox(name);
    try {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
      box.idb = await request(open);
    } catch (err) {
      console.warn('No outbox on this device; unsaved changes live in memory only', err);
    }
    return box;
  }

  constructor(name) {
    this.name = name;
    this.idb = null;
    this.seq = 0;
  }

  async all() {
    if (!this.idb) return [];
    return request(this.idb.transaction('ops', 'readonly').objectStore('ops').getAll());
  }

  /** Adds `entries` (setting each one's `seq`) and removes the seqs in `drop`. */
  async write(entries, drop) {
    if (!this.idb) {
      for (const e of entries) e.seq = ++this.seq;
      return;
    }
    const tx = this.idb.transaction('ops', 'readwrite');
    const done = finished(tx);
    const ops = tx.objectStore('ops');
    for (const seq of drop) ops.delete(seq);
    const seqs = await Promise.all(entries.map((e) => request(ops.add({ op: e.op, store: e.store, key: e.key, value: e.value }))));
    await done;
    entries.forEach((e, i) => { e.seq = seqs[i]; });
  }

  async remove(seqs) {
    if (!this.idb || !seqs.length) return;
    const tx = this.idb.transaction('ops', 'readwrite');
    const done = finished(tx);
    for (const seq of seqs) tx.objectStore('ops').delete(seq);
    await done;
  }

  close() {
    this.idb?.close();
  }

  /** Closes it and removes it from the device. */
  async destroy() {
    this.close();
    await deleteDatabase(this.name);
  }
}

// ----- the store -----------------------------------------------------------------

export class CloudDB {
  static outboxName(userId) {
    return `holly-outbox-${userId}`;
  }

  /** Holds the account's outbox for as long as this tab keeps it open, so
   * that when two tabs are open only the first replays what an earlier
   * session left unsent (a second copy could land after a newer change). */
  static holdOutbox(userId) {
    const free = { held: true, release: () => {} };
    if (typeof navigator === 'undefined' || !navigator.locks?.request) return Promise.resolve(free);
    return new Promise((resolve) => {
      navigator.locks.request(CloudDB.outboxName(userId), { ifAvailable: true }, (lock) => {
        if (!lock) return resolve({ held: false, release: () => {} });
        return new Promise((release) => resolve({ held: true, release }));
      }).catch(() => resolve(free));
    });
  }

  /**
   * Opens an account's storage: last session's unsent changes first, then the
   * small stores. Throws when the server can't be reached.
   * @param {object} o
   * @param {string} o.userId  the account
   * @param {(kind: 'query'|'mutation'|'action', name: string, args?: object) => Promise<any>} o.call
   *   calls a Convex function as that account, and throws "Not signed in" once
   *   it can't (signed out, or another account signed in meanwhile)
   * @param {object} [o.outbox]  where unsent changes wait (default: IndexedDB)
   * @param {(o?: { force?: boolean }) => Promise<string>} [o.token]  that
   *   account's session token, for Holly Bot's AI (src/core/providers)
   */
  static async open({ userId, call, outbox = null, token = null }) {
    if (!userId) throw new Error('Not signed in');
    const db = new CloudDB(userId, outbox || await Outbox.open(CloudDB.outboxName(userId)), call);
    db.sessionToken = token;
    const hold = await CloudDB.holdOutbox(userId);
    db.release = hold.release;
    try {
      if (hold.held) {
        for (const entry of await db.outbox.all()) {
          db.remember(entry);
          db.pending.push(entry);
        }
      }
      db.version = await db.call('query', 'data:version');
      await Promise.all(EAGER.map((store) => db.loadStore(store)));
    } catch (err) {
      db.release();
      db.outbox.close();
      throw err;
    }
    db.watch();
    db.kick();
    return db;
  }

  constructor(userId, outbox, call) {
    this.cloud = true;
    this.userId = userId;
    this.outbox = outbox;
    this.callServer = call;
    this.mem = new Map(Object.keys(SCHEMA).map((store) => [store, new Map()]));
    this.whole = new Set();
    this.groups = new Map(Object.keys(GROUP).map((store) => [store, new Set()]));
    this.loading = new Map();
    // Records this session wrote or deleted. Its own version wins over
    // anything loaded from the server afterwards.
    this.touched = new Set();
    this.pending = [];
    this.flushing = null;
    this.paused = false;
    this.stopped = false;
    this.blobs = new Map(); // storage id → Promise<Blob>
    this.uploaded = new WeakMap(); // Blob → { id, store, key }
    this.version = 0; // the account's change count as of what this device holds
    this.stale = false;
    this.onError = (message) => console.error(message);
    this.onStale = () => {};
    this.unwatch = () => {};
    this.release = () => {};
  }

  /** Calls the server as this storage's account (see `open`). */
  call(kind, name, args) {
    return this.callServer(kind, name, args);
  }

  remember({ op, store, key, value }) {
    if (op === 'put') this.mem.get(store).set(key, value);
    else this.mem.get(store).delete(key);
    this.touched.add(idOf(store, key));
  }

  absorb(store, value) {
    const key = keyOf(store, value);
    if (key === undefined || this.touched.has(idOf(store, key))) return;
    this.mem.get(store).set(key, value);
  }

  // ----- reading from the server ------------------------------------------------

  async decode(store, row) {
    const value = JSON.parse(row.overflowUrl ? await (await fetchOk(row.overflowUrl)).text() : row.data);
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && typeof v.__f32 === 'string') {
        const bytes = fromBase64(v.__f32);
        value[k] = new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
      }
    }
    return value;
  }

  /** Runs `work` once per `id` even when several callers ask at once. */
  once(id, work) {
    if (!this.loading.has(id)) this.loading.set(id, work().finally(() => this.loading.delete(id)));
    return this.loading.get(id);
  }

  async fetchPages(store, group) {
    let cursor = null;
    do {
      const res = await this.call('query', 'data:list', {
        store,
        ...(group === undefined ? null : { group: String(group) }),
        paginationOpts: { numItems: PAGE, cursor },
      });
      for (const value of await Promise.all(res.page.map((row) => this.decode(store, row)))) this.absorb(store, value);
      cursor = res.isDone ? null : res.continueCursor;
    } while (cursor);
  }

  loadStore(store) {
    if (this.whole.has(store)) return Promise.resolve();
    return this.once(store, async () => {
      await this.fetchPages(store);
      this.whole.add(store);
    });
  }

  loadGroup(store, group) {
    if (this.whole.has(store) || this.groups.get(store).has(group)) return Promise.resolve();
    return this.once(idOf(store, group), async () => {
      await this.fetchPages(store, group);
      this.groups.get(store).add(group);
    });
  }

  async ensure(store, index, range) {
    if (this.whole.has(store)) return;
    const group = groupOf(store, index, range);
    if (group !== undefined) await this.loadGroup(store, group);
    else await this.loadStore(store);
  }

  matches(store, index, range) {
    const keyPath = SCHEMA[store].keyPath;
    const path = index ? pathOf(store, index) : null;
    const rows = [];
    for (const value of this.mem.get(store).values()) {
      const k = index ? indexKey(path, value) : value[keyPath];
      if (k !== undefined && k !== null && inRange(range, k)) rows.push({ k, value });
    }
    return rows.sort((a, b) => compareKeys(a.k, b.k)).map(({ value }) => value);
  }

  /** The newest `limit` rows of one group, without loading the rest of it. */
  async latest(store, index, range, group, limit) {
    const mem = this.mem.get(store);
    let deleted = 0;
    for (const id of this.touched) if (id.startsWith(`${store}\n`) && !mem.has(id.slice(store.length + 1))) deleted++;
    const want = Math.min(limit + deleted, 100);
    const rows = await this.call('query', 'data:tail', { store, group: String(group), limit: want });
    const values = await Promise.all(rows.map((row) => this.decode(store, row)));
    for (const value of values) this.absorb(store, value);
    const complete = rows.length < want;
    if (complete) this.groups.get(store).add(group);
    const field = SORT[store];
    // Older rows than the ones fetched may be missing here, so only rows at
    // least as new as the oldest fetched one (or written here) can answer.
    const floor = complete ? -Infinity : Math.min(...values.map((v) => v[field] ?? -Infinity));
    return this.matches(store, index, range)
      .filter((v) => (v[field] ?? -Infinity) >= floor || this.touched.has(idOf(store, keyOf(store, v))))
      .reverse()
      .slice(0, limit);
  }

  /** A row as the app sees it: file contents as Blobs (or text), fetched when
   * first needed. Without `contents` they stay out (listings don't need them). */
  async materialize(store, value, { contents = true } = {}) {
    let out = value;
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && !(v instanceof Blob) && typeof v.__blob === 'string') {
        if (out === value) out = { ...value };
        if (!contents) out[k] = undefined;
        else if (v.text) out[k] = await (await this.blob(v.__blob, v.type)).text();
        else out[k] = await this.blob(v.__blob, v.type, store, keyOf(store, value));
      }
    }
    return copy(out);
  }

  blob(id, type, store, key) {
    if (!this.blobs.has(id)) {
      const load = (async () => {
        const url = await this.call('query', 'data:blobUrl', { storageId: id });
        const blob = url ? new Blob([await (await fetchOk(url)).blob()], { type: type || '' }) : new Blob([], { type: type || '' });
        this.uploaded.set(blob, { id, store, key });
        return blob;
      })();
      load.catch(() => this.blobs.delete(id));
      this.blobs.set(id, load);
    }
    return this.blobs.get(id);
  }

  // ----- the DB interface -----------------------------------------------------------

  async get(store, key) {
    const mem = this.mem.get(store);
    if (!mem.has(key) && !this.whole.has(store) && !this.touched.has(idOf(store, key))) {
      const row = await this.call('query', 'data:get', { store, key: String(key) });
      if (row) this.absorb(store, await this.decode(store, row));
    }
    return mem.has(key) ? this.materialize(store, mem.get(key)) : undefined;
  }

  async put(store, value) {
    await this.putMany(store, [value]);
    return value;
  }

  async putMany(store, values) {
    if (!values.length) return values;
    const entries = values.map((value) => {
      const key = keyOf(store, value);
      const stored = copy(value);
      this.mem.get(store).set(key, stored);
      return { op: 'put', store, key, value: stored };
    });
    await this.enqueue(entries);
    return values;
  }

  async delete(store, key) {
    await this.deleteMany(store, [key]);
  }

  async deleteMany(store, keys) {
    if (!keys.length) return;
    for (const key of keys) this.mem.get(store).delete(key);
    await this.enqueue(keys.map((key) => ({ op: 'delete', store, key })));
  }

  async all(store) {
    await this.loadStore(store);
    return Promise.all([...this.mem.get(store).values()].map((value) => this.materialize(store, value)));
  }

  async clear(store) {
    await this.drain(20_000);
    this.paused = true;
    try {
      await Promise.resolve(this.flushing).catch(() => {}); // a batch sent since finishes first
      for (let done = false; !done;) {
        const res = await this.call('mutation', 'data:clearStore', { store });
        this.note(res);
        done = res.done;
      }
    } finally {
      this.paused = false;
    }
    this.mem.get(store).clear();
    this.whole.add(store);
    for (const id of [...this.touched]) if (id.startsWith(`${store}\n`)) this.touched.delete(id);
    // Anything written to this store while the server was clearing it still goes up.
    for (const entry of this.pending) if (entry.store === store) this.remember(entry);
    this.kick();
  }

  /** Like DB.query; `contents: false` leaves out file contents (a listing). */
  async query(store, index, range, { direction = 'next', limit = Infinity, contents = true } = {}) {
    let rows;
    const group = groupOf(store, index, range);
    if (SORT[store] && direction === 'prev' && Number.isFinite(limit) && group !== undefined && wholeGroup(range)
      && !this.whole.has(store) && !this.groups.get(store).has(group)) {
      rows = await this.latest(store, index, range, group, limit);
    } else {
      await this.ensure(store, index, range);
      rows = this.matches(store, index, range);
      if (direction === 'prev') rows.reverse();
      rows = rows.slice(0, limit);
    }
    return Promise.all(rows.map((value) => this.materialize(store, value, { contents })));
  }

  async count(store, index, range) {
    await this.ensure(store, index, range);
    return this.matches(store, index, range).length;
  }

  async deleteWhere(store, index, range) {
    await this.ensure(store, index, range);
    const keys = this.matches(store, index, range).map((value) => keyOf(store, value));
    await this.deleteMany(store, keys);
    return keys.length;
  }

  exportAll(opts) {
    return DB.prototype.exportAll.call(this, opts);
  }

  importAll(data, opts) {
    return DB.prototype.importAll.call(this, data, opts);
  }

  // ----- other devices ----------------------------------------------------------------

  /** Checks for other devices' changes when the app comes back to the front,
   * when the connection returns, and every minute while it's on screen (or,
   * on Holly Bot Computer, every minute). */
  watch() {
    if (typeof document === 'undefined') {
      const timer = setInterval(() => this.checkFresh(), CHECK_EVERY);
      timer.unref?.();
      this.unwatch = () => clearInterval(timer);
      return;
    }
    const onOnline = () => {
      this.kick();
      this.checkFresh();
    };
    const onShow = () => document.visibilityState === 'visible' && this.checkFresh();
    const timer = setInterval(onShow, CHECK_EVERY);
    addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onShow);
    this.unwatch = () => {
      clearInterval(timer);
      removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onShow);
    };
  }

  /** Takes in the change count a write came back with. */
  note({ prev, version }) {
    if (prev !== this.version) this.markStale();
    this.version = version;
  }

  markStale() {
    if (this.stale) return;
    this.stale = true;
    this.onStale();
  }

  /** Whether this device still holds the account as it is on the server.
   * False once another device changed it, or while that can't be checked. */
  async fresh() {
    if (this.stale) return false;
    try {
      if ((await this.call('query', 'data:version')) !== this.version) this.markStale();
    } catch {
      return false;
    }
    return !this.stale;
  }

  checkFresh() {
    if (!this.stale && !this.stopped) this.fresh().catch(() => {});
  }

  /** Takes on scheduled work (`key` due at `at`) for this device; false when
   * another device already has, or the server can't be reached (with
   * `strict`, that throws instead, for work to try again later). */
  async claim(key, at, { strict = false } = {}) {
    try {
      return await this.call('mutation', 'data:claim', { key: String(key), at });
    } catch (err) {
      if (strict) throw err;
      console.warn('claim', err);
      return false;
    }
  }

  // ----- writing to the server -------------------------------------------------------

  async enqueue(entries) {
    // A newer write to the same record replaces an older one still waiting.
    const ids = new Set(entries.map((e) => idOf(e.store, e.key)));
    const drop = [];
    this.pending = this.pending.filter((e) => {
      if (!ids.has(idOf(e.store, e.key))) return true;
      drop.push(e.seq);
      return false;
    });
    for (const e of entries) this.touched.add(idOf(e.store, e.key));
    await this.outbox.write(entries, drop);
    this.pending.push(...entries);
    this.kick();
  }

  kick() {
    if (this.flushing || this.paused || this.stopped || !this.pending.length) return;
    this.flushing = this.flush().finally(() => {
      this.flushing = null;
      if (!this.paused && !this.stopped && this.pending.length) setTimeout(() => this.kick(), 1000);
    });
  }

  async upload(blob, store, key) {
    const known = this.uploaded.get(blob);
    if (known && known.store === store && known.key === key) return known.id;
    const url = await this.call('mutation', 'data:uploadUrl');
    const res = await fetchOk(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    const { storageId } = await res.json();
    if (store !== undefined) this.uploaded.set(blob, { id: storageId, store, key });
    return storageId;
  }

  async encode({ op, store, key, value }) {
    if (op === 'delete') return { op, store, key: String(key) };
    const out = { ...value };
    const blobs = [];
    for (const [k, v] of Object.entries(out)) {
      if (v instanceof Blob) {
        const id = await this.upload(v, store, key);
        out[k] = { __blob: id, type: v.type, size: v.size };
        blobs.push(id);
      } else if (v instanceof Float32Array) {
        out[k] = { __f32: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      } else if (typeof v === 'string' && v.length > BIG_TEXT) {
        const id = await this.upload(new Blob([v], { type: 'text/plain;charset=utf-8' }));
        out[k] = { __blob: id, type: 'text/plain;charset=utf-8', text: true };
        blobs.push(id);
      } else if (v && typeof v === 'object' && typeof v.__blob === 'string') {
        blobs.push(v.__blob);
      }
    }
    const put = { op, store, key: String(key), data: JSON.stringify(out), blobs };
    const group = value[GROUP[store]];
    if (GROUP[store] && group !== undefined && group !== null) put.group = String(group);
    if (SORT[store] && typeof value[SORT[store]] === 'number') put.sort = value[SORT[store]];
    if (put.data.length > MAX_DATA) {
      put.overflow = await this.upload(new Blob([put.data], { type: 'application/json' }));
      put.data = '';
    }
    return put;
  }

  /** Sends the outbox in order until it's empty, paused or signed out. */
  async flush() {
    let size = BATCH_OPS;
    let failures = 0;
    while (this.pending.length && !this.paused && !this.stopped) {
      const batch = [];
      const ops = [];
      let bytes = 0;
      let current = null;
      try {
        for (const entry of this.pending) {
          if (batch.length >= size || bytes >= BATCH_BYTES) break;
          current = entry;
          entry.encoded ||= await this.encode(entry);
          batch.push(entry);
          ops.push(entry.encoded);
          bytes += entry.encoded.data?.length || 0;
        }
        current = null;
        this.note(await this.call('mutation', 'data:apply', { ops }));
      } catch (err) {
        if (/not signed in/i.test(err?.message || '')) {
          this.stopped = true; // signed out: the outbox waits for this account's next sign-in
          return;
        }
        failures++;
        // Without an active subscription the server turns every change down,
        // so none is at fault: they wait until it's active again.
        if (inactive(err)) {
          await sleep(INACTIVE_WAIT);
          continue;
        }
        const refused = err?.data !== undefined; // a ConvexError: the server turned it down on purpose
        // Offline, or the server is having a moment: wait and try again, for as
        // long as it takes. Nothing is dropped while the server can't be reached.
        if (!refused && (isNetworkError(err) || failures < 6 || !(await this.reachable()))) {
          await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)));
          continue;
        }
        // The server is up but won't take something in this batch. Find it by
        // sending one change at a time, then set that change aside.
        if (size > 1) {
          size = 1;
          failures = 0;
          continue;
        }
        const bad = current || batch[0];
        if (bad && /upload not found/i.test(err?.message || '') && !bad.reuploaded) {
          bad.reuploaded = true;
          bad.encoded = null;
          for (const v of Object.values(bad.value || {})) if (v instanceof Blob) this.uploaded.delete(v);
          continue;
        }
        if (bad) {
          this.pending = this.pending.filter((e) => e !== bad);
          await this.outbox.remove([bad.seq]).catch(() => {});
          this.onError(`A change to ${bad.store} couldn't be saved: ${err?.message || err}`);
        }
        failures = 0;
        continue;
      }
      failures = 0;
      size = Math.min(BATCH_OPS, size * 2);
      const sent = new Set(batch);
      this.pending = this.pending.filter((e) => !sent.has(e));
      await this.outbox.remove(batch.map((e) => e.seq)).catch(() => {});
    }
  }

  /** Whether the server answers at all (a lookup that finds nothing). */
  async reachable() {
    try {
      await this.call('query', 'data:get', { store: 'kv', key: '\u0000probe' });
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves once everything written so far is on the server. */
  async drain(timeout = Infinity) {
    const until = Date.now() + timeout;
    while (this.pending.length && !this.stopped) {
      this.kick();
      const left = until - Date.now();
      if (left <= 0) throw new Error('Some changes are still waiting to be saved.');
      await Promise.race([this.flushing || sleep(50), sleep(Math.min(left, 1000))]);
    }
  }

  /** Sends what's left (waiting up to `timeout`) and stops. With `forget`,
   * and once nothing is left unsent, removes this account's outbox from the
   * device. */
  async close({ timeout = 8000, forget = false } = {}) {
    try {
      await this.drain(timeout);
    } catch (err) {
      console.warn('Unsent changes stay on this device until the next sign-in', err);
    }
    this.stopped = true;
    this.unwatch();
    this.release();
    if (forget && !this.pending.length) await this.outbox.destroy();
    else this.outbox.close();
  }

  /** Stops at once and drops what hasn't been sent, here and in the outbox
   * (the account is being deleted). */
  async discard() {
    this.stopped = true;
    this.pending = [];
    this.unwatch();
    await Promise.race([Promise.resolve(this.flushing).catch(() => {}), sleep(10_000)]); // a batch on its way lands first
    this.release();
    await this.outbox.destroy();
  }
}
