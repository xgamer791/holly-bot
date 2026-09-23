import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB, range } from '../../src/core/db.js';
import { MemoryStore, SHARED_ID, rankMemories, formatMemories } from '../../src/core/memory/store.js';

let n = 0;
const freshDb = () => DB.open(`test-${process.pid}-${n++}`);

test('db basic put/get/query/deleteWhere', async () => {
  const db = await freshDb();
  await db.putMany('messages', [
    { id: 'a', threadId: 't1', seq: 2, text: 'second' },
    { id: 'b', threadId: 't1', seq: 1, text: 'first' },
    { id: 'c', threadId: 't2', seq: 1, text: 'other' },
  ]);
  const rows = await db.query('messages', 'byThread', range.prefix(['t1']));
  assert.deepEqual(rows.map((r) => r.text), ['first', 'second']);
  const last = await db.query('messages', 'byThread', range.prefix(['t1']), { direction: 'prev', limit: 1 });
  assert.equal(last[0].text, 'second');
  assert.equal(await db.deleteWhere('messages', 'byThread', range.prefix(['t1'])), 2);
  assert.equal((await db.all('messages')).length, 1);
});

test('memory add dedupes and search ranks by relevance', async () => {
  const db = await freshDb();
  const changes = [];
  const store = new MemoryStore({ db, onChange: (id) => changes.push(id) });
  await store.add('agent1', { text: 'User has a golden retriever named Max', type: 'fact', importance: 6 });
  await store.add('agent1', { text: 'User prefers TypeScript over Python for web projects', type: 'preference' });
  await store.add('agent1', { text: 'User lives in Austin, Texas', type: 'fact', importance: 7 });
  const dup = await store.add('agent1', { text: 'The user has a golden retriever named Max.', importance: 8 });
  assert.equal(dup.action, 'merged');
  assert.equal((await store.list('agent1')).length, 3);
  // Without an embeddings key, matching is lexical/fuzzy (no synonyms), so use overlapping words.
  const res = await store.search('agent1', 'my golden dog');
  assert.match(res[0].memory.text, /golden retriever/);
  const res2 = await store.search('agent1', 'retriever');
  assert.match(res2[0].memory.text, /retriever/);
  assert.equal(res2[0].memory.importance, 8);
  assert.ok(changes.length >= 4);
});

test('shared memories are included when requested and isolated otherwise', async () => {
  const db = await freshDb();
  const store = new MemoryStore({ db });
  await store.add('a1', { text: 'Project Falcon launches on October 3rd' });
  await store.add(SHARED_ID, { text: 'Team rule: always cite sources for research' });
  await store.add('a2', { text: 'Nova handles all calendar scheduling' });
  const own = await store.search('a1', 'cite sources research');
  assert.equal(own.length, 0);
  const withShared = await store.search('a1', 'cite sources research', { includeShared: true });
  assert.equal(withShared[0].memory.agentId, SHARED_ID);
  const other = await store.search('a1', 'calendar scheduling', { includeShared: true });
  assert.equal(other.length, 0, 'agent memories must stay private');
});

test('embedder is used when available', async () => {
  const db = await freshDb();
  const vec = (t) => Float32Array.from(t.includes('dog') || t.includes('retriever') ? [1, 0] : [0, 1]);
  const embedder = { id: 'fake:2d', embed: async (texts) => texts.map(vec) };
  const store = new MemoryStore({ db, getEmbedder: () => embedder });
  await store.add('a', { text: 'Has a golden retriever' });
  await store.add('a', { text: 'Works night shifts as a nurse' });
  await store.reindex('a');
  const list = await store.list('a');
  assert.ok(list.every((m) => m.embModel === 'fake:2d'));
  const res = await store.search('a', 'my dog');
  assert.match(res[0].memory.text, /retriever/);
});

test('rankMemories without query favors importance/pins and formatMemories renders ids', () => {
  const now = Date.now();
  const mems = [
    { id: 'm1', text: 'low', importance: 2, createdAt: now, updatedAt: now, type: 'fact', agentId: 'a' },
    { id: 'm2', text: 'high', importance: 9, createdAt: now, updatedAt: now, type: 'goal', agentId: 'a' },
    { id: 'm3', text: 'pinned', importance: 1, pinned: true, createdAt: now, updatedAt: now, type: 'note', agentId: 'a' },
  ];
  const ranked = rankMemories(mems, '', { limit: 3 });
  assert.deepEqual(ranked.map((r) => r.memory.id), ['m2', 'm3', 'm1']);
  assert.match(formatMemories(ranked), /\[m2\] \(goal, saved \d{4}-\d{2}-\d{2}\) high/);
});
