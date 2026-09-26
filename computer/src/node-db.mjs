// File-backed database for Holly Bot Computer with the same interface as the
// browser's IndexedDB wrapper (src/core/db.js), so the shared app core runs
// unchanged in Node. Each store lives in memory and is persisted as an
// append-only JSONL log (compacted on startup and when it grows); Blobs are
// written to separate files.

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, unlinkSync, openAsBlob, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA } from '../../src/core/db.js';

// ----- IDBKeyRange polyfill (enough for the app core) -----------------------

function typeRank(k) {
  if (typeof k === 'number') return 1;
  if (k instanceof Date) return 2;
  if (typeof k === 'string') return 3;
  if (Array.isArray(k)) return 5;
  return 4;
}

export function compareKeys(a, b) {
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

export class KeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    Object.assign(this, { lower, upper, lowerOpen, upperOpen });
  }
  static only(k) { return new KeyRange(k, k); }
  static bound(a, b, lo = false, hi = false) { return new KeyRange(a, b, lo, hi); }
  static lowerBound(a, open = false) { return new KeyRange(a, undefined, open, false); }
  static upperBound(b, open = false) { return new KeyRange(undefined, b, false, open); }
  includes(k) {
    if (this.lower !== undefined) {
      const c = compareKeys(k, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = compareKeys(k, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = KeyRange;

// ----- value encoding (Blobs → files, typed arrays → base64) ----------------

const BLOB = '__hollyBlob';
const F32 = '__hollyF32';

function keyOf(def, value) {
  return value[def.keyPath];
}

function indexKey(spec, value) {
  const path = typeof spec === 'string' || Array.isArray(spec) ? spec : spec.keyPath;
  if (Array.isArray(path)) {
    const parts = path.map((p) => value?.[p]);
    return parts.some((p) => p === undefined || p === null) ? undefined : parts;
  }
  return value?.[path];
}

export class NodeDB {
  constructor(dir) {
    this.dir = dir;
    this.blobDir = join(dir, 'blobs');
    this.stores = new Map();
    this.logSizes = new Map();
  }

  static async open(dir) {
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const db = new NodeDB(dir);
    for (const name of Object.keys(SCHEMA)) db.load(name);
    return db;
  }

  logPath(store) {
    return join(this.dir, `${store}.jsonl`);
  }

  load(store) {
    const map = new Map();
    const file = this.logPath(store);
    let lines = 0;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines++;
        try {
          const rec = JSON.parse(line);
          if (rec.d !== undefined) map.delete(JSON.stringify(rec.d));
          else if (rec.v !== undefined) map.set(JSON.stringify(keyOf(SCHEMA[store], rec.v)), rec.v);
          else if (rec.clear) map.clear();
        } catch { /* skip a torn final line */ }
      }
    }
    this.stores.set(store, map);
    this.logSizes.set(store, lines);
    if (lines > map.size * 2 + 50) this.compact(store);
  }

  compact(store) {
    const map = this.stores.get(store);
    const file = this.logPath(store);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, [...map.values()].map((v) => JSON.stringify({ v })).join('\n') + (map.size ? '\n' : ''));
    renameSync(tmp, file);
    this.logSizes.set(store, map.size);
  }

  append(store, entry) {
    appendFileSync(this.logPath(store), `${JSON.stringify(entry)}\n`);
    const n = (this.logSizes.get(store) || 0) + 1;
    this.logSizes.set(store, n);
    if (n > 2000 && n > this.stores.get(store).size * 3) this.compact(store);
  }

  async encode(store, value) {
    const out = { ...value };
    for (const [k, v] of Object.entries(out)) {
      if (typeof Blob !== 'undefined' && v instanceof Blob) {
        const name = `${store}-${String(keyOf(SCHEMA[store], value)).replace(/[^\w.-]/g, '_')}-${k}`;
        writeFileSync(join(this.blobDir, name), Buffer.from(await v.arrayBuffer()));
        out[k] = { [BLOB]: name, type: v.type };
      } else if (v instanceof Float32Array) {
        out[k] = { [F32]: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
      }
    }
    return out;
  }

  async decode(value) {
    if (!value) return value;
    let copy = null;
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && v[BLOB]) {
        copy ||= { ...value };
        const path = join(this.blobDir, v[BLOB]);
        copy[k] = existsSync(path) ? await openAsBlob(path, { type: v.type }) : new Blob([], { type: v.type });
      } else if (v && typeof v === 'object' && v[F32]) {
        copy ||= { ...value };
        const buf = Buffer.from(v[F32], 'base64');
        copy[k] = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      }
    }
    return copy || structuredClone(value);
  }

  async get(store, key) {
    return this.decode(this.stores.get(store).get(JSON.stringify(key)));
  }

  async put(store, value) {
    const enc = await this.encode(store, value);
    this.stores.get(store).set(JSON.stringify(keyOf(SCHEMA[store], value)), enc);
    this.append(store, { v: enc });
    return value;
  }

  async putMany(store, values) {
    for (const v of values) await this.put(store, v);
    return values;
  }

  async delete(store, key) {
    const k = JSON.stringify(key);
    const prev = this.stores.get(store).get(k);
    if (!prev) return;
    this.stores.get(store).delete(k);
    this.append(store, { d: key });
    this.removeBlobs(prev);
  }

  removeBlobs(rec) {
    for (const v of Object.values(rec || {})) {
      if (v && typeof v === 'object' && v[BLOB]) {
        try {
          unlinkSync(join(this.blobDir, v[BLOB]));
        } catch { /* already gone */ }
      }
    }
  }

  async deleteMany(store, keys) {
    for (const k of keys) await this.delete(store, k);
  }

  async all(store) {
    return Promise.all([...this.stores.get(store).values()].map((v) => this.decode(v)));
  }

  async clear(store) {
    for (const rec of this.stores.get(store).values()) this.removeBlobs(rec);
    this.stores.get(store).clear();
    this.append(store, { clear: true });
    this.compact(store);
  }

  matches(store, index, range) {
    const rows = [...this.stores.get(store).values()];
    if (!index) {
      const def = SCHEMA[store];
      return rows.map((v) => ({ v, k: keyOf(def, v) })).filter(({ k }) => inRange(range, k)).sort((a, b) => compareKeys(a.k, b.k));
    }
    const spec = SCHEMA[store].indexes[index];
    return rows.map((v) => ({ v, k: indexKey(spec, v) })).filter(({ k }) => k !== undefined && inRange(range, k)).sort((a, b) => compareKeys(a.k, b.k));
  }

  async query(store, index, range, { direction = 'next', limit = Infinity } = {}) {
    let rows = this.matches(store, index, range);
    if (direction === 'prev') rows = rows.reverse();
    return Promise.all(rows.slice(0, limit).map(({ v }) => this.decode(v)));
  }

  async count(store, index, range) {
    return this.matches(store, index, range).length;
  }

  async deleteWhere(store, index, range) {
    const rows = this.matches(store, index, range);
    for (const { v } of rows) await this.delete(store, keyOf(SCHEMA[store], v));
    return rows.length;
  }

  async exportAll(opts) {
    const { DB } = await import('../../src/core/db.js');
    return DB.prototype.exportAll.call(this, opts);
  }

  async importAll(data, opts) {
    const { DB } = await import('../../src/core/db.js');
    return DB.prototype.importAll.call(this, data, opts);
  }

  close() {
    for (const name of this.stores.keys()) this.compact(name);
  }

  sizeOnDisk() {
    let total = 0;
    for (const name of this.stores.keys()) {
      try {
        total += statSync(this.logPath(name)).size;
      } catch { /* none */ }
    }
    return total;
  }
}

function inRange(range, key) {
  if (range === undefined || range === null) return true;
  if (range instanceof KeyRange || (typeof range === 'object' && 'lower' in range && 'upper' in range && typeof range.includes === 'function')) return range.includes(key);
  return compareKeys(key, range) === 0;
}
