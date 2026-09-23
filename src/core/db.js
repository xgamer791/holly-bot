// Promise-based IndexedDB wrapper. Everything the app knows lives here, in the
// user's own browser: API keys, agents, chats, memories, files, routines.

export const DB_VERSION = 1;

/** Object stores and their indexes. Bump DB_VERSION and extend `upgrade` to change. */
export const SCHEMA = {
  kv: { keyPath: 'key' },
  agents: { keyPath: 'id' },
  threads: { keyPath: 'id', indexes: { byUpdated: 'updatedAt' } },
  messages: { keyPath: 'id', indexes: { byThread: ['threadId', 'seq'] } },
  memories: { keyPath: 'id', indexes: { byAgent: 'agentId' } },
  files: { keyPath: 'id', indexes: { byAgent: 'agentId', byPath: { keyPath: ['agentId', 'path'], unique: true } } },
  routines: { keyPath: 'id', indexes: { byAgent: 'agentId', byNext: 'nextRunAt' } },
  tasks: { keyPath: 'id', indexes: { byTo: 'toAgentId', byFrom: 'fromAgentId' } },
  activity: { keyPath: 'id', indexes: { byAgent: ['agentId', 'createdAt'] } },
};

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

function upgrade(db) {
  for (const [name, def] of Object.entries(SCHEMA)) {
    if (db.objectStoreNames.contains(name)) continue;
    const store = db.createObjectStore(name, { keyPath: def.keyPath });
    for (const [indexName, spec] of Object.entries(def.indexes || {})) {
      if (typeof spec === 'string' || Array.isArray(spec)) store.createIndex(indexName, spec);
      else store.createIndex(indexName, spec.keyPath, { unique: !!spec.unique });
    }
  }
}

export class DB {
  constructor(idb) {
    this.idb = idb;
  }

  static async open(name = 'holly') {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => upgrade(open.result);
    const idb = await req(open);
    idb.onversionchange = () => idb.close();
    return new DB(idb);
  }

  close() {
    this.idb.close();
  }

  async get(store, key) {
    const tx = this.idb.transaction(store, 'readonly');
    return req(tx.objectStore(store).get(key));
  }

  async put(store, value) {
    const tx = this.idb.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await txDone(tx);
    return value;
  }

  async putMany(store, values) {
    if (!values.length) return values;
    const tx = this.idb.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    await txDone(tx);
    return values;
  }

  async delete(store, key) {
    const tx = this.idb.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }

  async deleteMany(store, keys) {
    if (!keys.length) return;
    const tx = this.idb.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    await txDone(tx);
  }

  async all(store) {
    const tx = this.idb.transaction(store, 'readonly');
    return req(tx.objectStore(store).getAll());
  }

  async clear(store) {
    const tx = this.idb.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await txDone(tx);
  }

  /**
   * Query an index. `range` may be an IDBKeyRange, a single key, or undefined for all.
   * Options: { direction: 'next'|'prev', limit }.
   */
  async query(store, index, range, { direction = 'next', limit = Infinity } = {}) {
    const tx = this.idb.transaction(store, 'readonly');
    const source = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
    if (direction === 'next' && limit === Infinity) return req(source.getAll(range));
    return new Promise((resolve, reject) => {
      const out = [];
      const cursorReq = source.openCursor(range, direction);
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || out.length >= limit) return resolve(out);
        out.push(cursor.value);
        cursor.continue();
      };
    });
  }

  async count(store, index, range) {
    const tx = this.idb.transaction(store, 'readonly');
    const source = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
    return req(source.count(range));
  }

  /** Delete every record matched by an index range. Returns the number deleted. */
  async deleteWhere(store, index, range) {
    const tx = this.idb.transaction(store, 'readwrite');
    const source = tx.objectStore(store).index(index);
    let n = 0;
    await new Promise((resolve, reject) => {
      const cursorReq = source.openCursor(range);
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        cursor.delete();
        n++;
        cursor.continue();
      };
    });
    await txDone(tx);
    return n;
  }

  /** Export every store as plain JSON-able data (Blobs become data URLs). */
  async exportAll({ includeKeys = true } = {}) {
    const out = { app: 'holly-bot', version: DB_VERSION, exportedAt: new Date().toISOString(), stores: {} };
    for (const name of Object.keys(SCHEMA)) {
      let rows = await this.all(name);
      if (name === 'kv' && !includeKeys) {
        rows = rows.map((r) => (r.key === 'settings' ? { ...r, value: stripSecrets(r.value) } : r));
      }
      if (name === 'files') {
        rows = await Promise.all(rows.map(async (f) => (f.blob instanceof Blob
          ? { ...f, blob: undefined, dataUrl: await blobToDataUrl(f.blob) }
          : f)));
      }
      out.stores[name] = rows;
    }
    return out;
  }

  async importAll(data, { replace = false } = {}) {
    if (!data || data.app !== 'holly-bot' || !data.stores) throw new Error('Not a Holly backup file');
    for (const [name, rows] of Object.entries(data.stores)) {
      if (!SCHEMA[name] || !Array.isArray(rows)) continue;
      if (replace) await this.clear(name);
      const fixed = name === 'files'
        ? await Promise.all(rows.map(async (f) => (f.dataUrl ? { ...f, dataUrl: undefined, blob: await dataUrlToBlob(f.dataUrl) } : f)))
        : rows;
      await this.putMany(name, fixed);
    }
  }
}

export function stripSecrets(settings) {
  if (!settings) return settings;
  const clone = structuredClone(settings);
  for (const p of Object.values(clone.providers || {})) if (p) p.apiKey = '';
  for (const k of Object.keys(clone.services || {})) if (clone.services[k]) clone.services[k].apiKey = '';
  return clone;
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export const range = {
  only: (k) => IDBKeyRange.only(k),
  bound: (a, b, lo = false, hi = false) => IDBKeyRange.bound(a, b, lo, hi),
  /** All compound keys starting with `prefix` (e.g. ['threadId'] for ['threadId', seq]). */
  prefix: (prefix) => IDBKeyRange.bound([...prefix], [...prefix, []]),
  upTo: (k) => IDBKeyRange.upperBound(k),
};
