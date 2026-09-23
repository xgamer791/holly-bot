import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDB, compareKeys } from '../../computer/src/node-db.mjs';
import { range } from '../../src/core/db.js';

test('key ordering matches IndexedDB (numbers < strings < arrays)', () => {
  assert.ok(compareKeys(5, 'a') < 0);
  assert.ok(compareKeys('b', ['a']) < 0);
  assert.ok(compareKeys(['t1', 2], ['t1', 10]) < 0);
  assert.ok(compareKeys(['t1', 99], ['t1', []]) < 0);
});

test('NodeDB persists, queries by compound index, stores blobs and Float32Arrays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollydb-'));
  try {
    let db = await NodeDB.open(dir);
    await db.putMany('messages', [
      { id: 'a', threadId: 't1', seq: 2, text: 'second' },
      { id: 'b', threadId: 't1', seq: 1, text: 'first' },
      { id: 'c', threadId: 't2', seq: 1, text: 'other' },
    ]);
    await db.put('files', { id: 'f1', agentId: 'bot', path: 'a.bin', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-test' }) });
    await db.put('memories', { id: 'm1', agentId: 'bot', text: 'x', emb: Float32Array.from([0.5, -1]) });
    await db.delete('messages', 'c');
    db = await NodeDB.open(dir); // reload from disk
    const rows = await db.query('messages', 'byThread', range.prefix(['t1']));
    assert.deepEqual(rows.map((r) => r.text), ['first', 'second']);
    assert.equal(await db.get('messages', 'c'), undefined);
    const last = await db.query('messages', 'byThread', range.prefix(['t1']), { direction: 'prev', limit: 1 });
    assert.equal(last[0].text, 'second');
    const f = await db.get('files', 'f1');
    assert.deepEqual([...new Uint8Array(await f.blob.arrayBuffer())], [1, 2, 3]);
    assert.equal(f.blob.type, 'application/x-test');
    const m = await db.get('memories', 'm1');
    assert.ok(m.emb instanceof Float32Array);
    assert.deepEqual([...m.emb], [0.5, -1]);
    assert.equal(await db.count('messages', 'byThread', range.prefix(['t1'])), 2);
    assert.equal(await db.deleteWhere('messages', 'byThread', range.prefix(['t1'])), 2);
    assert.equal((await db.all('messages')).length, 0);
    const byPath = await db.query('files', 'byPath', range.only(['bot', 'a.bin']));
    assert.equal(byPath.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
