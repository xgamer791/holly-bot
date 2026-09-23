// Small, dependency-free helpers shared by core and UI code.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function uid(prefix = 'id') {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

let seqCounter = 0;
/** Monotonic, sortable sequence number for ordering messages created in the same millisecond. */
export function nextSeq() {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() + seqCounter / 1000;
}

export const now = () => Date.now();

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Rough token estimate (~4 chars/token for English, conservative for code/CJK). */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 3.6);
}

export function truncate(text, max, marker = '…') {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Keep the head and tail of long tool output so both the start and the conclusion survive. */
export function truncateMiddle(text, max) {
  if (!text || text.length <= max) return text || '';
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n\n…[${text.length - 2 * half} characters omitted]…\n\n${text.slice(-half)}`;
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Pull the first JSON object/array out of model text (handles ```json fences and chatter).
 * Returns null if nothing parses.
 */
export function extractJson(text) {
  if (!text) return null;
  const direct = safeJsonParse(text.trim());
  if (direct !== null) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const v = safeJsonParse(fence[1].trim());
    if (v !== null) return v;
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const v = safeJsonParse(text.slice(start, i + 1));
          if (v !== null) return v;
          break;
        }
      }
    }
  }
  return null;
}

const DAY = 86400000;

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Today 2:06 PM", "Yesterday 9:10 AM", "Mon 4:00 PM", "Sep 3, 4:00 PM". */
export function formatDayTime(ts, ref = Date.now()) {
  const diff = startOfDay(ref) - startOfDay(ts);
  const clock = formatClock(ts);
  if (diff <= 0) return `Today ${clock}`;
  if (diff === DAY) return `Yesterday ${clock}`;
  if (diff < 7 * DAY) return `${new Date(ts).toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  return `${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** Compact relative label for lists: "now", "5m", "3h", "Mon", "Sep 3". */
export function formatShort(ts, ref = Date.now()) {
  const s = Math.round((ref - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (startOfDay(ts) === startOfDay(ref)) return formatClock(ts);
  if (ref - ts < 7 * DAY) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isoDate(ts = Date.now(), tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

export function localTimeContext(ts = Date.now(), tz) {
  const d = new Date(ts);
  let zone = tz;
  if (!zone) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch { /* ignore */ }
  }
  const opts = zone ? { timeZone: zone } : {};
  let date;
  let time;
  try {
    date = d.toLocaleDateString('en-US', { ...opts, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    time = d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' });
  } catch {
    date = d.toDateString();
    time = d.toTimeString().slice(0, 5);
  }
  return `${date}, ${time}${zone ? ` (${zone})` : ''}`;
}

/** Stable string hash (FNV-1a 32-bit). */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

export function deepClone(v) {
  return v === undefined ? v : structuredClone(v);
}

export class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.map.get(type)?.delete(fn);
  }
  emit(type, payload) {
    for (const fn of this.map.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`listener for ${type} failed`, err);
      }
    }
    for (const fn of this.map.get('*') || []) {
      try {
        fn(type, payload);
      } catch (err) {
        console.error('wildcard listener failed', err);
      }
    }
  }
}

export function errorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.name === 'AbortError') return 'Stopped';
  return err.message || String(err);
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError';
}
