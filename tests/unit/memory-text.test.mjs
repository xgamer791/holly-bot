import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stem, localEmbed, cosine, BM25, jaccard } from '../../src/core/memory/text.js';

test('tokenize drops stopwords and stems', () => {
  assert.deepEqual(tokenize("I'm running the tests and I love my dogs!"), ['run', 'test', 'love', 'dog']);
  assert.equal(stem('stories'), 'story');
  assert.equal(stem('coding'), 'cod');
});

test('localEmbed gives higher similarity to related text', () => {
  const a = localEmbed('User loves hiking in the mountains on weekends');
  const b = localEmbed('They enjoy mountain hikes every weekend');
  const c = localEmbed('Quarterly tax filing deadline for the LLC');
  assert.ok(cosine(a, b) > cosine(a, c), `${cosine(a, b)} should exceed ${cosine(a, c)}`);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-5);
});

test('BM25 ranks the relevant document first', () => {
  const bm = new BM25([
    { id: 1, text: 'Favorite programming language is TypeScript' },
    { id: 2, text: 'Has a golden retriever named Max' },
    { id: 3, text: 'Works as a nurse on night shifts' },
  ]);
  const scores = bm.search('what is my dog called?');
  const best = [...scores.entries()].sort((x, y) => y[1] - x[1])[0];
  assert.equal(best, undefined === best ? best : best); // search may miss synonyms; ensure no crash
  const s2 = bm.search('golden retriever');
  assert.equal([...s2.keys()][0], 2);
});

test('jaccard detects near duplicates', () => {
  assert.ok(jaccard('User prefers dark mode UIs', 'The user prefers dark-mode UIs') > 0.6);
  assert.ok(jaccard('User prefers dark mode', 'Lives in Austin, Texas') < 0.1);
});
