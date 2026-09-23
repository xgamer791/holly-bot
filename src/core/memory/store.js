import { uid, now as nowFn, truncate } from '../util.js';
import { BM25, localEmbed, cosine, jaccard } from './text.js';
import { range } from '../db.js';

// Long-term memory for each agent. Every agent owns a private set of memories;
// SHARED_ID holds the team notebook all agents can read and write.

export const SHARED_ID = '__shared__';

export const MEMORY_TYPES = ['fact', 'preference', 'person', 'project', 'event', 'goal', 'instruction', 'reflection', 'note'];

const DAY = 86400000;

/**
 * Rank memories for a query. Pure function (no I/O) so it is easy to test.
 * Combines BM25 keyword relevance, embedding similarity (provider embeddings
 * when both sides have them, otherwise the local hashing embedding), recency
 * and importance.
 */
export function rankMemories(memories, query, {
  queryVec = null, embedModel = null, now = Date.now(), limit = 8, minScore = 0.12,
  localCache = null,
} = {}) {
  if (!memories.length) return [];
  const q = String(query || '').trim();
  const bm = new BM25(memories.map((m) => ({ id: m.id, text: `${m.text} ${(m.tags || []).join(' ')}` })));
  const lex = q ? bm.search(q) : new Map();
  const maxLex = Math.max(0, ...lex.values());
  const qLocal = q ? localEmbed(q) : null;

  const scored = memories.map((m) => {
    let sem = 0;
    if (q) {
      if (queryVec && embedModel && m.embModel === embedModel && m.emb) {
        sem = cosine(queryVec, m.emb);
      } else {
        const key = `${m.id}:${m.updatedAt}`;
        let v = localCache?.get(key);
        if (!v) {
          v = localEmbed(m.text);
          localCache?.set(key, v);
        }
        // Hashing embeddings are noisier; scale into a comparable range.
        sem = Math.max(0, cosine(qLocal, v)) * 0.9;
      }
    }
    const lexN = maxLex > 0 ? (lex.get(m.id) || 0) / maxLex : 0;
    const age = Math.max(0, now - (m.lastAccessedAt || m.updatedAt || m.createdAt || now));
    const recency = Math.exp(-age / (30 * DAY));
    const importance = Math.min(10, Math.max(1, m.importance || 5)) / 10;
    const relevance = q ? 0.55 * sem + 0.45 * lexN : 0;
    let score = q ? relevance * 0.72 + recency * 0.1 + importance * 0.18 : recency * 0.4 + importance * 0.6;
    if (m.pinned) score += 0.15;
    return { memory: m, score, relevance, parts: { sem, lex: lexN, recency, importance } };
  });

  return scored
    .filter((s) => !q || s.memory.pinned || s.relevance >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export class MemoryStore {
  /**
   * @param {object} opts
   * @param {import('../db.js').DB} opts.db
   * @param {() => (null | { id: string, embed: (texts: string[]) => Promise<Float32Array[]> })} [opts.getEmbedder]
   */
  constructor({ db, getEmbedder = () => null, onChange = () => {} }) {
    this.db = db;
    this.getEmbedder = getEmbedder;
    this.onChange = onChange;
    this.localCache = new Map();
  }

  async list(agentId, { includeArchived = false } = {}) {
    const rows = await this.db.query('memories', 'byAgent', range.only(agentId));
    return rows.filter((m) => includeArchived || !m.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id) {
    return this.db.get('memories', id);
  }

  async count(agentId) {
    return this.db.count('memories', 'byAgent', range.only(agentId));
  }

  /**
   * Add a memory, merging into a near-duplicate if one exists.
   * Returns { memory, action: 'added' | 'merged' }.
   */
  async add(agentId, { text, type = 'fact', importance = 5, tags = [], source = null, pinned = false } = {}) {
    const clean = truncate(String(text || '').trim(), 1200);
    if (!clean) throw new Error('Memory text is empty');
    const existing = await this.list(agentId);
    const dup = findDuplicate(existing, clean);
    const t = nowFn();
    if (dup) {
      const merged = {
        ...dup,
        text: clean.length >= dup.text.length * 0.6 ? clean : dup.text,
        importance: Math.max(dup.importance || 5, importance),
        tags: [...new Set([...(dup.tags || []), ...tags])].slice(0, 12),
        updatedAt: t,
        emb: clean === dup.text ? dup.emb : null,
        embModel: clean === dup.text ? dup.embModel : null,
      };
      await this.db.put('memories', merged);
      this.onChange(agentId);
      this.embedLater([merged]);
      return { memory: merged, action: 'merged' };
    }
    const memory = {
      id: uid('mem'),
      agentId,
      type: MEMORY_TYPES.includes(type) ? type : 'note',
      text: clean,
      importance: Math.round(Math.min(10, Math.max(1, Number(importance) || 5))),
      tags: (tags || []).map(String).slice(0, 12),
      pinned: !!pinned,
      createdAt: t,
      updatedAt: t,
      lastAccessedAt: t,
      accessCount: 0,
      source,
      emb: null,
      embModel: null,
    };
    await this.db.put('memories', memory);
    this.onChange(agentId);
    this.embedLater([memory]);
    return { memory, action: 'added' };
  }

  async update(id, patch) {
    const m = await this.get(id);
    if (!m) throw new Error(`No memory with id ${id}`);
    const next = { ...m, ...patch, id: m.id, agentId: m.agentId, updatedAt: nowFn() };
    if (patch.text && patch.text !== m.text) {
      next.text = truncate(String(patch.text).trim(), 1200);
      next.emb = null;
      next.embModel = null;
    }
    if (patch.importance != null) next.importance = Math.round(Math.min(10, Math.max(1, Number(patch.importance) || 5)));
    await this.db.put('memories', next);
    this.onChange(m.agentId);
    if (!next.emb) this.embedLater([next]);
    return next;
  }

  async remove(id) {
    const m = await this.get(id);
    if (!m) return false;
    await this.db.delete('memories', id);
    this.onChange(m.agentId);
    return true;
  }

  async clear(agentId) {
    await this.db.deleteWhere('memories', 'byAgent', range.only(agentId));
    this.onChange(agentId);
  }

  /** Mark memories as recently used (boosts recency for future retrieval). */
  async touch(memories) {
    const t = nowFn();
    await this.db.putMany('memories', memories.map((m) => ({ ...m, lastAccessedAt: t, accessCount: (m.accessCount || 0) + 1 })));
  }

  /**
   * Hybrid search across an agent's memories (and optionally the shared notebook).
   * Returns [{ memory, score }].
   */
  async search(agentId, query, { limit = 8, includeShared = false, types = null, touch = true, minScore } = {}) {
    let pool = await this.list(agentId);
    if (includeShared && agentId !== SHARED_ID) pool = pool.concat(await this.list(SHARED_ID));
    if (types?.length) pool = pool.filter((m) => types.includes(m.type));
    if (!pool.length) return [];
    let queryVec = null;
    let embedModel = null;
    const embedder = this.activeEmbedder();
    if (embedder && query && pool.some((m) => m.embModel === embedder.id)) {
      try {
        [queryVec] = await embedder.embed([query]);
        embedModel = embedder.id;
      } catch (err) {
        this.embedFailed(err);
      }
    }
    const ranked = rankMemories(pool, query, { queryVec, embedModel, limit, localCache: this.localCache, ...(minScore != null ? { minScore } : {}) });
    if (touch && ranked.length) this.touch(ranked.map((r) => r.memory)).catch(() => {});
    return ranked;
  }

  /** Fire-and-forget embedding for new/changed memories when an embedder is configured. */
  embedLater(memories) {
    const embedder = this.activeEmbedder();
    if (!embedder || !memories.length) return;
    this.embedMany(memories, embedder).catch((err) => this.embedFailed(err));
  }

  /** The configured embedder, unless it failed recently (then local similarity is used for a while). */
  activeEmbedder() {
    if (this.embedPausedUntil && Date.now() < this.embedPausedUntil) return null;
    return this.getEmbedder();
  }

  embedFailed(err) {
    this.embedPausedUntil = Date.now() + 10 * 60 * 1000;
    console.warn('embedding failed; using local similarity for 10 minutes', err?.message || err);
  }

  async embedMany(memories, embedder = this.getEmbedder()) {
    if (!embedder) return 0;
    const todo = memories.filter((m) => m.embModel !== embedder.id);
    let done = 0;
    for (let i = 0; i < todo.length; i += 64) {
      const batch = todo.slice(i, i + 64);
      const vecs = await embedder.embed(batch.map((m) => m.text));
      const rows = [];
      for (let j = 0; j < batch.length; j++) {
        const fresh = await this.get(batch[j].id);
        if (!fresh || fresh.text !== batch[j].text) continue;
        rows.push({ ...fresh, emb: vecs[j], embModel: embedder.id });
      }
      await this.db.putMany('memories', rows);
      done += rows.length;
    }
    return done;
  }

  /** Backfill embeddings for every memory of an agent (e.g. after adding an embeddings key). */
  async reindex(agentId) {
    this.embedPausedUntil = 0;
    const embedder = this.getEmbedder();
    if (!embedder) return 0;
    return this.embedMany(await this.list(agentId, { includeArchived: true }), embedder);
  }
}

export function findDuplicate(existing, text) {
  const v = localEmbed(text);
  let best = null;
  let bestScore = 0;
  for (const m of existing) {
    const j = jaccard(m.text, text);
    const c = cosine(v, localEmbed(m.text));
    const s = Math.max(j, c * 0.95);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return bestScore >= 0.82 ? best : null;
}

/** Format memories for a prompt: "- [id] (type, importance) text". */
export function formatMemories(ranked, { withIds = true } = {}) {
  return ranked.map(({ memory: m }) => {
    const when = new Date(m.createdAt).toISOString().slice(0, 10);
    const scope = m.agentId === SHARED_ID ? 'shared, ' : '';
    return `- ${withIds ? `[${m.id}] ` : ''}(${scope}${m.type}, saved ${when}) ${m.text}`;
  }).join('\n');
}
