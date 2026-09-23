// Text utilities for memory retrieval: tokenizer + light stemmer, BM25, and a
// local "hashing" embedding (character n-grams + words) that gives fuzzy
// semantic-ish matching with zero network calls. Real provider embeddings are
// layered on top when the user has a key for one.

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from
further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i
i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or
other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the
their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until
up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why
why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also just like really get got
will im ive dont thats ok okay yeah yes hey hi please thanks thank user assistant`.split(/\s+/));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ness')) return w.slice(0, -4);
  if (w.endsWith('ments')) return w.slice(0, -5);
  if (w.endsWith('ment') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('ingly')) return w.slice(0, -5);
  if (w.endsWith('edly')) return w.slice(0, -4);
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && /(sh|ch|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

function undouble(w) {
  return /([bdfgklmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** Lowercase word tokens without stopwords, stemmed. Keeps numbers and non-Latin letters. */
export function tokenize(text) {
  const out = [];
  const words = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[\p{L}\p{N}][\p{L}\p{N}']*/gu) || [];
  for (let w of words) {
    w = w.replace(/'s$/, '').replace(/'+/g, '');
    if (!w || STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function fnv(str, seed = 0x811c9dc5) {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const LOCAL_DIMS = 384;

/**
 * Hashing-trick embedding: word unigrams, word bigrams and character trigrams
 * hashed into a fixed-size signed vector, then L2-normalized.
 */
export function localEmbed(text, dims = LOCAL_DIMS) {
  const v = new Float32Array(dims);
  const toks = tokenize(text);
  const add = (feature, weight) => {
    const h = fnv(feature);
    const idx = h % dims;
    v[idx] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (let i = 0; i < toks.length; i++) {
    add('w:' + toks[i], 1.0);
    if (i + 1 < toks.length) add('b:' + toks[i] + ' ' + toks[i + 1], 0.6);
    const padded = `#${toks[i]}#`;
    for (let j = 0; j + 3 <= padded.length; j++) add('c:' + padded.slice(j, j + 3), 0.35);
  }
  return normalize(v);
}

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Okapi BM25 over an in-memory corpus. docs: [{ id, text }] */
export class BM25 {
  constructor(docs, { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map((d) => {
      const toks = tokenize(d.text);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { id: d.id, len: toks.length, tf };
    });
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.N);
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  idf(t) {
    const df = this.df.get(t) || 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  /** Returns Map(id -> score) for docs with any overlap. */
  search(query) {
    const q = [...new Set(tokenize(query))];
    const scores = new Map();
    if (!q.length) return scores;
    for (const d of this.docs) {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += this.idf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgdl || 1))));
      }
      if (s > 0) scores.set(d.id, s);
    }
    return scores;
  }
}

/** Jaccard similarity of token sets — cheap near-duplicate check. */
export function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
