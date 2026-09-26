// Holli Bot Computer's outbox: changes to the account that the server doesn't
// have yet, one file each, so they survive a restart or a network outage and
// go up in order when it's back. The browser keeps the same in IndexedDB; both
// have the methods src/account/cloud-db.js uses. A file's contents are written
// beside its entry.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BLOB = '__outboxBlob';
const F32 = '__outboxF32';
const ENTRY = /^(\d+)\.json$/;

export class FileOutbox {
  static async open(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const box = new FileOutbox(dir);
    for (const name of await readdir(dir)) {
      const m = name.match(ENTRY);
      if (m) box.seq = Math.max(box.seq, Number(m[1]));
    }
    return box;
  }

  constructor(dir) {
    this.dir = dir;
    this.seq = 0;
  }

  path(name) {
    return join(this.dir, name);
  }

  async all() {
    const seqs = (await readdir(this.dir)).map((name) => name.match(ENTRY)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    const entries = [];
    for (const seq of seqs) {
      try {
        const { op, store, key, value } = JSON.parse(await readFile(this.path(`${seq}.json`), 'utf8'));
        entries.push({ seq, op, store, key, value: value && (await this.decode(value)) });
      } catch (err) {
        console.warn(`Skipping an unreadable change in ${this.dir} (${seq}): ${err.message}`);
      }
    }
    return entries;
  }

  /** Adds `entries` (setting each one's `seq`) and removes the seqs in `drop`. */
  async write(entries, drop) {
    for (const e of entries) e.seq = ++this.seq;
    await Promise.all(entries.map(async (e) => {
      const value = e.value && (await this.encode(e.seq, e.value));
      const file = this.path(`${e.seq}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify({ op: e.op, store: e.store, key: e.key, value }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }));
    await this.remove(drop);
  }

  async remove(seqs) {
    if (!seqs.length) return;
    const gone = new Set(seqs.map(String));
    const names = await readdir(this.dir);
    await Promise.all(names.filter((name) => gone.has(name.split('.')[0])).map((name) => rm(this.path(name), { force: true })));
  }

  async encode(seq, value) {
    const out = { ...value };
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof Blob) {
        const name = `${seq}.${Buffer.from(k).toString('hex')}.bin`;
        await writeFile(this.path(name), Buffer.from(await v.arrayBuffer()), { mode: 0o600 });
        out[k] = { [BLOB]: name, type: v.type };
      } else if (v instanceof Float32Array) {
        out[k] = { [F32]: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
      }
    }
    return out;
  }

  async decode(value) {
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && typeof v[BLOB] === 'string') {
        value[k] = new Blob([await readFile(this.path(v[BLOB]))], { type: v.type || '' });
      } else if (v && typeof v === 'object' && typeof v[F32] === 'string') {
        const bytes = Buffer.from(v[F32], 'base64');
        value[k] = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
    }
    return value;
  }

  close() {}

  /** Removes it from the computer. */
  async destroy() {
    await rm(this.dir, { recursive: true, force: true });
  }
}
