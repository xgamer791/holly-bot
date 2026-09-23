import { uid, now } from './util.js';
import { range } from './db.js';

// Each bot has its own small drive (IndexedDB). Text files are stored as
// strings, everything else as Blobs.

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|svg|ya?ml|toml|ini|cfg|log|sh|bash|zsh|ps1|bat|sql|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|lua|r|tex|env|gitignore)$/i;

const MIME_BY_EXT = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/jsonl', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
  py: 'text/x-python', html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml', svg: 'image/svg+xml',
  yaml: 'text/yaml', yml: 'text/yaml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};

export function guessMime(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || (TEXT_EXT.test(path) ? 'text/plain' : 'application/octet-stream');
}

export function isTextPath(path, mime = '') {
  return TEXT_EXT.test(path) || /^text\/|json|xml|javascript|svg/.test(mime);
}

export function normalizePath(p) {
  const parts = [];
  for (const seg of String(p || '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new Error('Paths may not contain ".."');
    parts.push(seg.replace(/[\u0000-\u001f<>:"|?*]/g, '_'));
  }
  const out = parts.join('/');
  if (!out) throw new Error('Empty path');
  if (out.length > 240) throw new Error('Path too long');
  return out;
}

export class FileStore {
  constructor({ db, onChange = () => {} }) {
    this.db = db;
    this.onChange = onChange;
  }

  async list(agentId, prefix = '') {
    const rows = await this.db.query('files', 'byAgent', range.only(agentId));
    const pre = prefix ? normalizePath(prefix) + '/' : '';
    return rows
      .filter((f) => !pre || f.path.startsWith(pre))
      .map(({ text, blob, ...meta }) => meta)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async get(agentId, path) {
    let p;
    try {
      p = normalizePath(path);
    } catch {
      return null;
    }
    const rows = await this.db.query('files', 'byPath', range.only([agentId, p]));
    return rows[0] || null;
  }

  async getById(id) {
    return this.db.get('files', id);
  }

  /** Write text (string) or binary (Blob) content. */
  async write(agentId, path, content, { mime, source = 'bot' } = {}) {
    const p = normalizePath(path);
    const existing = await this.get(agentId, p);
    const isBlob = typeof Blob !== 'undefined' && content instanceof Blob;
    const type = mime || (isBlob && content.type) || guessMime(p);
    const size = isBlob ? content.size : new TextEncoder().encode(String(content ?? '')).length;
    if (size > 25 * 1024 * 1024) throw new Error('File too large (25 MB limit)');
    const t = now();
    const file = {
      id: existing?.id || uid('file'),
      agentId,
      path: p,
      mime: type,
      size,
      text: isBlob ? undefined : String(content ?? ''),
      blob: isBlob ? content : undefined,
      source,
      createdAt: existing?.createdAt || t,
      updatedAt: t,
    };
    await this.db.put('files', file);
    this.onChange(agentId, file);
    return file;
  }

  async remove(agentId, path) {
    const f = await this.get(agentId, path);
    if (!f) return false;
    await this.db.delete('files', f.id);
    this.onChange(agentId, null);
    return true;
  }

  async clear(agentId) {
    await this.db.deleteWhere('files', 'byAgent', range.only(agentId));
    this.onChange(agentId, null);
  }

  /** Read a file as text (decoding Blobs when they look textual). */
  async readText(agentId, path) {
    const f = await this.get(agentId, path);
    if (!f) return null;
    if (f.text != null) return f.text;
    if (f.blob && isTextPath(f.path, f.mime)) return f.blob.text();
    return null;
  }
}

export async function fileToBlob(file) {
  if (file.blob) return file.blob;
  return new Blob([file.text ?? ''], { type: file.mime || 'text/plain' });
}
