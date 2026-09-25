// A real Chrome / Edge / Brave / Chromium for the bots, driven over the Chrome
// DevTools Protocol with Node's built-in WebSocket (no Puppeteer). Pages come
// back as readable text with numbered refs like [e12] for things the bot can
// click or type into. Each bot gets its own tab; the phone can watch any tab.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import os from 'node:os';
import { imageSize } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAGE_CHARS = 60000;

export function findChrome(env = process.env, platform = process.platform) {
  if (env.HOLLY_BROWSER) return existsSync(env.HOLLY_BROWSER) ? env.HOLLY_BROWSER : null;
  const candidates = [];
  if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', join(os.homedir(), 'Applications')]) {
      candidates.push(
        join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        join(base, 'Brave Browser.app/Contents/MacOS/Brave Browser'),
        join(base, 'Chromium.app/Contents/MacOS/Chromium'),
      );
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
    for (const name of names) {
      for (const dir of String(env.PATH || '').split(delimiter)) if (dir) candidates.push(join(dir, name));
    }
    candidates.push('/snap/bin/chromium', '/opt/google/chrome/chrome');
  }
  return candidates.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }) || null;
}

/** Turn what a person would type into an address bar into a URL. */
export function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('No URL given.');
  if (/^javascript:/i.test(s)) throw new Error('javascript: URLs are not allowed.');
  if (/^(https?|file|about|data|chrome|edge|brave|view-source|blob):/i.test(s)) return s;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s) && !/\s/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

// ----- DevTools connection ----------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    ws.onmessage = (e) => this.onMessage(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The browser closed.'));
      this.pending.clear();
      for (const h of this.handlers) h({ method: 'Holly.closed', params: {} });
    };
  }

  static connect(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch { /* closing */ }
        reject(new Error('Timed out connecting to the browser.'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to the browser (${e?.message || 'connection error'}).`));
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('The browser closed.'));
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      else p.resolve(msg.result || {});
      return;
    }
    for (const h of this.handlers) h(msg);
  }

  on(fn) {
    this.handlers.add(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch { /* already closed */ }
  }
}

// ----- In-page scripts (run inside the web page; plain ES2020) ------------------------------

/* eslint-disable no-undef */
function pageSnapshot(maxChars) {
  const refs = window.__hollyRefs || (window.__hollyRefs = Object.create(null));
  const ids = window.__hollyIds || (window.__hollyIds = new WeakMap());
  if (!window.__hollyN) window.__hollyN = 0;
  const refOf = (el) => {
    let r = ids.get(el);
    if (!r || refs[r] !== el) {
      r = `e${++window.__hollyN}`;
      ids.set(el, r);
      refs[r] = el;
    }
    return r;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MAP']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LEGEND', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL']);
  const ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const visible = (el) => {
    if (el.checkVisibility) {
      if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
    } else if (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return true;
    return getComputedStyle(el).display === 'contents';
  };
  const roleOf = (el) => {
    const tag = el.tagName;
    const aria = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'file') return 'file-input';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'select';
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'editable';
    if (ROLES.has(aria)) return aria;
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'clickable';
    return null;
  };
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => (el.ownerDocument.getElementById(id) || {}).innerText || '').join(' ');
      if (t.trim()) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels).map((l) => l.innerText).join(' ');
        if (t.trim()) return t;
      }
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return el.value || el.type;
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    }
    const text = el.innerText;
    if (text && text.trim()) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && img.alt) return img.alt;
    return el.getAttribute('title') || '';
  };
  const describe = (el, role, ref) => {
    const tag = el.tagName;
    const label = clip(labelOf(el), 100);
    let s = `[${ref}] ${role}${label ? ` "${label}"` : ''}`;
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && href !== '#' && !/^javascript:/i.test(href)) {
        let h = el.href;
        try {
          const u = new URL(el.href);
          h = u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
        } catch { /* keep */ }
        s += ` → ${clip(h, 90)}`;
      }
      if (el.target === '_blank') s += ' (opens a new tab)';
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'editable') {
      const v = role === 'editable' ? el.innerText : el.value;
      if ((el.type || '').toLowerCase() === 'password') s += v ? ' = "••••"' : '';
      else if (v) s += ` = "${clip(v, 160)}"`;
      else if (el.getAttribute('placeholder') && !label.includes(el.getAttribute('placeholder'))) s += ` (placeholder "${clip(el.getAttribute('placeholder'), 60)}")`;
      if (tag === 'TEXTAREA') s += ' (multi-line)';
      if (tag === 'INPUT' && !['text', 'search', ''].includes((el.type || '').toLowerCase())) s += ` (${el.type})`;
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const on = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true';
      s += on ? ' (checked)' : ' (not checked)';
    }
    if (role === 'select') {
      const sel = el.selectedOptions && el.selectedOptions[0];
      if (sel) s += ` = "${clip(sel.label, 60)}"`;
      const opts = Array.from(el.options).slice(0, 25).map((o) => clip(o.label, 40));
      s += ` options: ${opts.join(' | ')}${el.options.length > 25 ? ` | …(${el.options.length} total)` : ''}`;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' (disabled)';
    const exp = el.getAttribute('aria-expanded');
    if (exp) s += exp === 'true' ? ' (expanded)' : ' (collapsed)';
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page') s += ' (current)';
    if (el.ownerDocument.activeElement === el) s += ' (focused)';
    return s;
  };

  const lines = [];
  let line = '';
  let size = 0;
  let truncated = false;
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    line = '';
    if (!t) return;
    lines.push(t);
    size += t.length + 1;
    if (size > maxChars) truncated = true;
  };
  const visit = (node, pointerAbove) => {
    if (truncated) return;
    if (node.nodeType === 3) {
      line += node.data;
      if (line.length > 4000) flush();
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 11) {
      for (let c = node.firstChild; c; c = c.nextSibling) visit(c, pointerAbove);
      return;
    }
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;
    if (tag === 'SLOT') {
      const assigned = el.assignedNodes({ flatten: true });
      const list = assigned.length ? assigned : Array.from(el.childNodes);
      for (const c of list) visit(c, pointerAbove);
      return;
    }
    if (!visible(el)) return;
    if (tag === 'IFRAME' || tag === 'FRAME') {
      flush();
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch { /* cross-origin */ }
      if (doc && doc.body) {
        line += `[frame${el.title ? ` "${clip(el.title, 60)}"` : ''}]`;
        flush();
        visit(doc.body, false);
        flush();
        line += '[end of frame]';
      } else {
        line += `[embedded frame${el.title ? ` "${clip(el.title, 60)}"` : ''} — can't be read; use a screenshot and click_xy inside it]`;
      }
      flush();
      return;
    }
    let role = roleOf(el);
    let pointer = pointerAbove;
    if (!role) {
      pointer = getComputedStyle(el).cursor === 'pointer';
      if (pointer && !pointerAbove && (el.innerText || '').trim()) role = 'clickable';
    }
    if (role && role !== 'clickable') {
      line += ` ${describe(el, role, refOf(el))} `;
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    if (tag === 'HR') {
      line += '---';
      flush();
      return;
    }
    if (tag === 'IMG') {
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) line += ` [image: ${clip(alt, 80)}] `;
      return;
    }
    if (/^H[1-6]$/.test(tag)) line += `${'#'.repeat(Number(tag[1]))} `;
    else if (tag === 'LI') line += '• ';
    if (role === 'clickable') line += ` [${refOf(el)}] (clickable) `;
    const root = el.shadowRoot || el;
    for (let c = root.firstChild; c; c = c.nextSibling) visit(c, pointer || pointerAbove);
    if (tag === 'TD' || tag === 'TH') line += ' | ';
    if (block) flush();
  };
  visit(document.body || document.documentElement, false);
  flush();
  const header = [`Title: ${document.title || '(untitled)'}`, `URL: ${location.href}`];
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - innerHeight;
  if (scrollable > 20) header.push(`Scrolled ${Math.round(Math.min(100, (scrollY / scrollable) * 100))}% down (the text below is the whole page).`);
  const focused = document.activeElement && ids.get(document.activeElement);
  if (focused) header.push(`Focused: [${focused}]`);
  return {
    url: location.href,
    title: document.title,
    text: `${header.join('\n')}\n\n${lines.join('\n')}${truncated ? '\n… (page text cut off here — it is very long)' : ''}`,
  };
}

function hollyFind(ref, selector, text) {
  const refs = window.__hollyRefs || {};
  const ids = window.__hollyIds;
  const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const vis = (e) => (e.checkVisibility ? e.checkVisibility() : e.getClientRects().length > 0);
  let el = null;
  if (ref) {
    const r = `e${String(ref).replace(/[[\]\s]/g, '').replace(/^e/i, '')}`;
    el = refs[r];
    if (!el || !el.isConnected) return { error: `There is no [${r}] on the page now. Take a new snapshot and use a ref from it.` };
  } else if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: `Bad CSS selector: ${e.message}` };
    }
    if (!el) return { error: `Nothing on the page matches ${selector}.` };
  } else if (text) {
    const want = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const cands = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex],[contenteditable]')).filter(vis);
    el = cands.find((e) => label(e) === want) || cands.find((e) => label(e).startsWith(want)) || cands.find((e) => label(e).includes(want));
    if (!el) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.data.replace(/\s+/g, ' ').trim().toLowerCase().includes(want) && n.parentElement && vis(n.parentElement)) {
          el = n.parentElement;
          break;
        }
      }
    }
    if (!el) return { error: `Couldn't find anything on the page that says “${text}”.` };
  } else {
    return { error: 'Say which element: a ref like e12, some text on it, or a CSS selector.' };
  }
  window.__hollyTarget = el;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const info = {
    tag: el.tagName,
    type: (el.type || '').toLowerCase(),
    editable: !!el.isContentEditable,
    ref: (ids && ids.get(el)) || null,
    label: clip(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.tagName.toLowerCase(), 60),
  };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ...info, x: null, y: null };
  // Offset for elements inside same-origin frames.
  let ox = 0;
  let oy = 0;
  for (let w = el.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
    const fr = w.frameElement.getBoundingClientRect();
    ox += fr.left + w.frameElement.clientLeft;
    oy += fr.top + w.frameElement.clientTop;
  }
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const root = el.getRootNode();
  const top = (root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(cx, cy);
  const within = (a, b) => {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  };
  let covered = null;
  if (top && top !== el && !within(el, top) && !within(top, el)) {
    const lab = top.closest && top.closest('label');
    if (!(lab && (lab.control === el || lab.contains(el)))) {
      const cls = typeof top.className === 'string' && top.className.trim() ? `.${top.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      const tref = ids && ids.get(top);
      covered = `${tref ? `[${tref}] ` : ''}<${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${cls}>${top.innerText ? ` “${clip(top.innerText, 60)}”` : ''}`;
    }
  }
  return { ...info, x: cx + ox, y: cy + oy, covered };
}

function prepareTyping(el, clear) {
  const doc = el.ownerDocument;
  if (doc.activeElement !== el && !el.contains(doc.activeElement)) el.focus();
  const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  if (!clear) {
    if (isField) {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch { /* not all input types allow it */ }
    }
    return true;
  }
  if (isField && typeof el.select === 'function') el.select();
  else if (el.isContentEditable) {
    const sel = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

function forceValue(el, text) {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  if (el.value === text) return true;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === text;
}

function selectOption(el, text) {
  const want = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  const opts = Array.from(el.options);
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const o = opts.find((x) => norm(x.label) === want || norm(x.value) === want) || opts.find((x) => norm(x.label).startsWith(want)) || opts.find((x) => norm(x.label).includes(want));
  if (!o) return { error: `No option “${text}”. Options: ${opts.slice(0, 40).map((x) => x.label).join(' | ')}` };
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: o.label };
}
/* eslint-enable no-undef */

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`;

// ----- keys for the page -----------------------------------------------------------------

const PAGE_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
};
const PAGE_KEY_ALIASES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', up: 'ArrowUp', arrowup: 'ArrowUp', down: 'ArrowDown', arrowdown: 'ArrowDown', left: 'ArrowLeft', arrowleft: 'ArrowLeft',
  right: 'ArrowRight', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' ', spacebar: ' ',
  shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta',
};
const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function pageKey(name) {
  const n = PAGE_KEY_ALIASES[name.toLowerCase()] || name;
  if (PAGE_KEYS[n]) return { key: n, ...PAGE_KEYS[n] };
  const f = n.match(/^f([1-9]|1[0-2])$/i);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]) };
  if (n.length === 1) {
    const up = n.toUpperCase();
    if (/[a-z]/i.test(n)) return { key: n, code: `Key${up}`, keyCode: up.charCodeAt(0), text: n };
    if (/[0-9]/.test(n)) return { key: n, code: `Digit${n}`, keyCode: n.charCodeAt(0), text: n };
    return { key: n, code: '', keyCode: 0, text: n };
  }
  throw new Error(`Unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, Control+a.`);
}

// ----- the browser -------------------------------------------------------------------------

class Tab {
  constructor(targetId, sessionId) {
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.mainFrameId = null;
    this.loading = false;
    this.loads = 0;
    this.dcl = 0;
    this.dclAt = 0;
    this.popup = null;
    this.shotScale = 1;
    this.url = '';
    this.title = '';
  }
}

export class CdpBrowser {
  /** `env`: what Chrome runs with (its DISPLAY). `place(owner)`: where an
   * owner's own screen is ({ x, y, width, height }), when each bot has one
   * (computer/src/screens.mjs): its tabs then open in a window of its own
   * there, so bots browse side by side, with the same logins. */
  constructor({ executablePath, userDataDir, headless = false, log = console, downloadDir = null, width = 1280, height = 900, extraArgs = [], env = process.env, place = null } = {}) {
    this.executablePath = executablePath;
    this.extraArgs = extraArgs;
    this.env = env;
    this.place = place;
    this.owned = new Map(); // owner → Set of its windows' tabs (targetId), with place
    this.shown = new Map(); // owner → the tab last brought to the front in its window
    this.userDataDir = userDataDir;
    this.headless = headless;
    this.log = log;
    this.downloadDir = downloadDir;
    this.width = width;
    this.height = height;
    this.cdp = null;
    this.proc = null;
    this.tabs = new Map(); // sessionId → Tab
    this.owners = new Map(); // owner → Tab
    this.lastUsed = null;
    this.notes = [];
  }

  get running() {
    return !!(this.cdp && !this.cdp.closed);
  }

  async start() {
    if (this.running) return;
    this.starting ||= this.launch().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  async launch() {
    mkdirSync(this.userDataDir, { recursive: true });
    const wsUrl = (await this.existingEndpoint()) || (await this.spawnBrowser());
    const cdp = await Cdp.connect(wsUrl);
    this.cdp = cdp;
    this.tabs.clear();
    this.owners.clear();
    this.owned.clear();
    this.shown.clear();
    this.lastUsed = null;
    cdp.on((m) => this.onEvent(m));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    if (this.downloadDir) {
      mkdirSync(this.downloadDir, { recursive: true });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true }).catch(() => {});
    }
  }

  /** Reuse a browser left running with this profile (e.g. after Holly Computer restarts). */
  async existingEndpoint() {
    const file = join(this.userDataDir, 'DevToolsActivePort');
    if (!existsSync(file)) return null;
    try {
      const port = readFileSync(file, 'utf8').split('\n')[0].trim();
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return (await res.json()).webSocketDebuggerUrl || null;
    } catch {
      return null;
    }
  }

  spawnBrowser() {
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      `--window-size=${this.width},${this.height}`,
    ];
    if (this.headless) args.push('--headless=new');
    args.push(...this.extraArgs);
    if (process.platform === 'linux') {
      if (process.getuid?.() === 0) args.push('--no-sandbox');
      args.push('--disable-dev-shm-usage');
    }
    args.push('about:blank');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.env });
      } catch (err) {
        reject(new Error(`Could not start the browser: ${err.message}`));
        return;
      }
      this.proc = child;
      let errText = '';
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new Error(`The browser did not start in time. ${errText.slice(-300)}`)), 30000);
      // Chrome prints the endpoint on stderr and also writes DevToolsActivePort.
      const poll = setInterval(async () => {
        const url = await this.existingEndpoint();
        if (url) finish(resolve, url);
      }, 400);
      child.stderr.on('data', (d) => {
        errText = `${errText}${d}`.slice(-4000);
        const m = errText.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) finish(resolve, m[1]);
      });
      child.on('error', (err) => finish(reject, new Error(`Could not start the browser: ${err.message}`)));
      child.on('exit', (code) => {
        if (this.proc === child) this.proc = null;
        finish(reject, new Error(`The browser quit right away (${code}). ${errText.trim().split('\n').slice(-2).join(' ')}`));
      });
    });
  }

  onEvent(m) {
    const { method, params = {}, sessionId } = m;
    if (method === 'Holly.closed') {
      this.cdp = null;
      this.tabs.clear();
      this.owners.clear();
      this.owned.clear();
      this.shown.clear();
      this.lastUsed = null;
      return;
    }
    if (method === 'Target.targetCreated') {
      const t = params.targetInfo;
      if (t.type === 'page' && t.openerId) {
        for (const tab of this.tabs.values()) if (tab.targetId === t.openerId) tab.popup = t.targetId;
      }
      return;
    }
    if (method === 'Target.targetInfoChanged') {
      const t = params.targetInfo;
      for (const tab of this.tabs.values()) {
        if (tab.targetId === t.targetId) {
          tab.url = t.url;
          tab.title = t.title;
        }
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      for (const tab of [...this.tabs.values()]) if (tab.targetId === params.targetId) this.forget(tab);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const tab = this.tabs.get(params.sessionId);
      if (tab) this.forget(tab);
      return;
    }
    if (method === 'Browser.downloadWillBegin') {
      this.notes.push(`Downloading “${params.suggestedFilename}” to ${this.downloadDir}.`);
      return;
    }
    if (method === 'Browser.downloadProgress') {
      if (params.state === 'completed') this.notes.push('The download finished.');
      else if (params.state === 'canceled') this.notes.push('The download was canceled.');
      return;
    }
    const tab = sessionId && this.tabs.get(sessionId);
    if (!tab) return;
    switch (method) {
      case 'Page.javascriptDialogOpening':
        this.notes.push(`The page showed a ${params.type} dialog: “${String(params.message || '').slice(0, 300)}” — clicked OK.`);
        this.cdp?.send('Page.handleJavaScriptDialog', { accept: true, promptText: params.defaultPrompt || '' }, sessionId).catch(() => {});
        break;
      case 'Page.frameStartedLoading':
        if (!tab.mainFrameId || params.frameId === tab.mainFrameId) tab.loading = true;
        break;
      case 'Page.frameStoppedLoading':
        if (!tab.mainFrameId || params.frameId === tab.mainFrameId) tab.loading = false;
        break;
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          tab.mainFrameId = params.frame.id;
          tab.url = params.frame.url;
        }
        break;
      case 'Page.domContentEventFired':
        tab.dcl++;
        tab.dclAt = Date.now();
        break;
      case 'Page.loadEventFired':
        tab.loads++;
        break;
      default:
    }
  }

  forget(tab) {
    this.tabs.delete(tab.sessionId);
    for (const set of this.owned.values()) set.delete(tab.targetId);
    for (const [owner, t] of this.owners) if (t === tab) this.owners.delete(owner);
    if (this.lastUsed === tab) this.lastUsed = null;
  }

  async attach(targetId) {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId) return tab;
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(targetId, sessionId);
    this.tabs.set(sessionId, tab);
    await this.cdp.send('Page.enable', {}, sessionId);
    const tree = await this.cdp.send('Page.getFrameTree', {}, sessionId);
    tab.mainFrameId = tree.frameTree.frame.id;
    tab.url = tree.frameTree.frame.url;
    // Behave like the focused window even when it's in the background.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    return tab;
  }

  async pageTargets() {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  }

  async resolveTab(id) {
    const s = String(id || '').trim();
    const t = (await this.pageTargets()).find((x) => x.targetId === s || x.targetId.toLowerCase().startsWith(s.toLowerCase()));
    if (!t) throw new Error(`There is no tab "${s}". List them with the tabs action.`);
    return t.targetId;
  }

  /** The tab an owner (a bot, or the user) is working in; created on first use. */
  async tabFor({ owner = 'user', tab: tabId } = {}) {
    await this.start();
    let tab;
    if (tabId) {
      tab = await this.attach(await this.resolveTab(tabId));
      if (owner !== 'user') this.owners.set(owner, tab);
    } else if (owner === 'user') {
      tab = (this.lastUsed && this.tabs.has(this.lastUsed.sessionId) && this.lastUsed) || this.owners.get('user');
    } else {
      tab = this.owners.get(owner);
    }
    if (tab && !this.tabs.has(tab.sessionId)) tab = null;
    if (tab?.popup) {
      const popupId = tab.popup;
      tab.popup = null;
      if ((await this.pageTargets()).some((t) => t.targetId === popupId)) {
        tab = await this.attach(popupId);
        this.owners.set(owner, tab);
        await this.onScreen(owner, popupId);
        this.notes.push('The page opened a new tab — switched to it.');
      }
    }
    if (!tab) tab = await this.claimTab(owner);
    this.lastUsed = tab;
    // With a window each, a tab comes to the front only when the bot moves to
    // another: bringing a window forward takes the keyboard from the others.
    if (!this.place || this.shown.get(owner) !== tab.targetId) {
      this.shown.set(owner, tab.targetId);
      await this.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {});
    }
    return tab;
  }

  /** Puts a window of `owner`'s on its own screen, filling it. */
  async onScreen(owner, targetId) {
    if (!this.place) return;
    if (!this.owned.has(owner)) this.owned.set(owner, new Set());
    this.owned.get(owner).add(targetId);
    try {
      const b = await this.place(owner);
      const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId });
      await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: b.x, top: b.y, width: b.width, height: b.height } });
    } catch (err) {
      this.log.warn?.(`  Couldn't put a bot's browser window on its screen: ${err.message}`);
    }
  }

  /** `owner` gave up its screen: its windows close. */
  async release(owner) {
    const ids = [...(this.owned.get(owner) || [])];
    this.owned.delete(owner);
    this.shown.delete(owner);
    this.owners.delete(owner);
    for (const targetId of ids) await this.cdp?.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  async claimTab(owner) {
    const pages = await this.pageTargets();
    const taken = new Set([...this.owners.values()].map((t) => t.targetId));
    const blank = (t) => /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page|edge:\/\/newtab|chrome-search:)/.test(t.url);
    // With a screen each, a blank tab could be in another's window: only Chrome's first one is free.
    const spare = !this.place || !this.owned.size;
    const free = spare ? pages.find((t) => !taken.has(t.targetId) && blank(t)) || (taken.size === 0 && owner === 'user' ? pages[0] : null) : null;
    // With a screen each, a new window, on the owner's screen.
    const targetId = free ? free.targetId : (await this.cdp.send('Target.createTarget', { url: 'about:blank', ...(this.place ? { newWindow: true } : {}) })).targetId;
    const tab = await this.attach(targetId);
    this.owners.set(owner, tab);
    await this.onScreen(owner, targetId);
    return tab;
  }

  async eval(tab, expression, timeoutMs = 20000) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, tab.sessionId, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception?.description || d.text || 'Script error').split('\n')[0]);
    }
    return r.result?.value;
  }

  async waitForLoad(tab, since, timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs && this.tabs.has(tab.sessionId)) {
      if (tab.loads > since.loads) return;
      // Slow ads/trackers: once the document is parsed, don't wait more than 4s for "load".
      if (tab.dcl > since.dcl && Date.now() - tab.dclAt > 4000) return;
      await sleep(100);
    }
  }

  async settle(tab, ms = 400) {
    await sleep(ms);
    const t0 = Date.now();
    let waited = false;
    while (tab.loading && Date.now() - t0 < 12000 && this.tabs.has(tab.sessionId)) {
      waited = true;
      await sleep(100);
    }
    if (waited) await sleep(300);
  }

  takeNotes() {
    return this.notes.splice(0).join(' ');
  }

  async read(tab) {
    let page;
    try {
      page = await this.eval(tab, call(pageSnapshot, MAX_PAGE_CHARS));
    } catch (err) {
      if (!/context|navigat|destroyed|Cannot find/i.test(err.message)) throw err;
      await this.settle(tab, 600);
      page = await this.eval(tab, call(pageSnapshot, MAX_PAGE_CHARS));
    }
    const note = this.takeNotes();
    return { tab: tab.targetId.slice(0, 8), url: page.url, title: page.title, text: page.text, ...(note ? { note } : {}) };
  }

  async snapshot(o = {}) {
    return this.read(await this.tabFor(o));
  }

  async goto(url, o = {}) {
    const tab = await this.tabFor(o);
    const target = normalizeUrl(url);
    const since = { loads: tab.loads, dcl: tab.dcl };
    const r = await this.cdp.send('Page.navigate', { url: target }, tab.sessionId, 30000);
    if (r.errorText) throw new Error(`Couldn't open ${target}: ${r.errorText}`);
    if (r.loaderId) await this.waitForLoad(tab, since);
    await this.settle(tab, 300);
    return this.snapshot(o);
  }

  async mouseClick(tab, x, y, { button = 'left', clickCount = 1 } = {}) {
    const sid = tab.sessionId;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount }, sid);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount }, sid);
  }

  async find(tab, { ref, selector, text }) {
    const f = await this.eval(tab, call(hollyFind, ref, selector, text));
    if (!f || f.error) throw new Error(f?.error || 'Could not find that element.');
    return f;
  }

  async click(target = {}, o = {}) {
    const tab = await this.tabFor(o);
    const f = await this.find(tab, target);
    if (f.covered) {
      throw new Error(`Can't click ${f.ref ? `[${f.ref}]` : `“${f.label}”`}: ${f.covered} is on top of it. Close or dismiss that first (often a cookie banner or pop-up), then try again.`);
    }
    if (f.x == null) await this.eval(tab, 'window.__hollyTarget.click()');
    else await this.mouseClick(tab, f.x, f.y);
    await this.settle(tab, 500);
    return this.snapshot(o);
  }

  async type({ ref, selector, text = '', submit = false, clear = true } = {}, o = {}) {
    const tab = await this.tabFor(o);
    const value = String(text ?? '');
    if (!ref && !selector) {
      if (value) await this.cdp.send('Input.insertText', { text: value }, tab.sessionId);
      if (submit) await this.pressKey(tab, 'Enter');
      await this.settle(tab, submit ? 600 : 300);
      return this.snapshot(o);
    }
    const f = await this.find(tab, { ref, selector });
    if (f.tag === 'SELECT') {
      const r = await this.eval(tab, `(${selectOption.toString()})(window.__hollyTarget, ${JSON.stringify(value)})`);
      if (r.error) throw new Error(r.error);
      this.notes.push(`Picked “${r.selected}”.`);
      await this.settle(tab, 400);
      return this.snapshot(o);
    }
    if (f.type === 'checkbox' || f.type === 'radio') throw new Error('That is a checkbox or radio button — use click to change it.');
    if (f.x != null && !f.covered) await this.mouseClick(tab, f.x, f.y);
    await this.eval(tab, `(${prepareTyping.toString()})(window.__hollyTarget, ${clear ? 'true' : 'false'})`);
    if (value) await this.cdp.send('Input.insertText', { text: value }, tab.sessionId);
    if (clear) await this.eval(tab, `(${forceValue.toString()})(window.__hollyTarget, ${JSON.stringify(value)})`).catch(() => {});
    if (submit) await this.pressKey(tab, 'Enter');
    await this.settle(tab, submit ? 700 : 300);
    return this.snapshot(o);
  }

  async typeText(text, o = {}) {
    return this.type({ text }, o);
  }

  async pressKey(tab, combo) {
    const sid = tab.sessionId;
    const parts = String(combo).split(/\+(?=.)/).map((p) => p.trim()).filter(Boolean);
    const defs = parts.map(pageKey);
    const main = defs.pop();
    let modifiers = 0;
    for (const m of defs) {
      modifiers |= MOD_BITS[m.key] || 0;
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers }, sid);
    }
    const shortcut = (modifiers & (MOD_BITS.Control | MOD_BITS.Meta)) !== 0;
    let text = shortcut ? undefined : main.text;
    if (text && modifiers & MOD_BITS.Shift) text = text.toUpperCase();
    const letter = main.key.length === 1 ? main.key.toLowerCase() : '';
    let command = shortcut ? EDIT_COMMANDS[letter] : undefined;
    if (command === 'undo' && modifiers & MOD_BITS.Shift) command = 'redo';
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: text && text.length === 1 && main.key.length === 1 ? text : main.key,
      code: main.code,
      windowsVirtualKeyCode: main.keyCode,
      modifiers,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    }, sid);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: main.key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers }, sid);
    for (const m of defs.reverse()) {
      modifiers &= ~(MOD_BITS[m.key] || 0);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers }, sid);
    }
  }

  async press(keys = 'Enter', o = {}) {
    const tab = await this.tabFor(o);
    const list = String(keys).trim() === '' ? [' '] : String(keys).trim().split(/\s+/);
    for (const k of list) await this.pressKey(tab, k);
    await this.settle(tab, 500);
    return this.snapshot(o);
  }

  async scroll({ direction = 'down', amount } = {}, o = {}) {
    const tab = await this.tabFor(o);
    const [w, h] = await this.eval(tab, '[innerWidth, innerHeight]');
    const pages = Number(amount) > 0 ? Math.min(Number(amount), 20) : 1;
    const dy = (direction === 'up' ? -1 : 1) * Math.round(h * 0.8 * pages);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: dy }, tab.sessionId);
    await sleep(450);
    return this.snapshot(o);
  }

  async history(delta, o = {}) {
    const tab = await this.tabFor(o);
    const h = await this.cdp.send('Page.getNavigationHistory', {}, tab.sessionId);
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) {
      this.notes.push(delta < 0 ? 'There is no earlier page in this tab.' : 'There is no later page in this tab.');
      return this.snapshot(o);
    }
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, tab.sessionId);
    await this.settle(tab, 600);
    return this.snapshot(o);
  }

  back(o) {
    return this.history(-1, o);
  }

  forward(o) {
    return this.history(1, o);
  }

  async reload(o = {}) {
    const tab = await this.tabFor(o);
    const since = { loads: tab.loads, dcl: tab.dcl };
    await this.cdp.send('Page.reload', {}, tab.sessionId);
    await this.waitForLoad(tab, since);
    await this.settle(tab, 300);
    return this.snapshot(o);
  }

  async listTabs(o = {}) {
    await this.start();
    const mine = this.owners.get(o.owner || 'user') || (o.owner === 'user' ? this.lastUsed : null);
    return (await this.pageTargets()).map((t) => ({
      id: t.targetId.slice(0, 8),
      title: t.title || '(untitled)',
      url: t.url,
      active: !!mine && mine.targetId === t.targetId,
    }));
  }

  async newTab(url, o = {}) {
    await this.start();
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', ...(this.place ? { newWindow: true } : {}) });
    const tab = await this.attach(targetId);
    this.owners.set(o.owner || 'user', tab);
    await this.onScreen(o.owner || 'user', targetId);
    this.lastUsed = tab;
    const opts = { owner: o.owner || 'user' };
    if (url && url !== 'about:blank') return this.goto(url, opts);
    return this.snapshot(opts);
  }

  async switchTab(id, o = {}) {
    await this.start();
    return this.snapshot({ owner: o.owner || 'user', tab: id });
  }

  async closeTab(id, o = {}) {
    await this.start();
    const owner = o.owner || 'user';
    const targetId = id ? await this.resolveTab(id) : (await this.tabFor(o)).targetId;
    await this.cdp.send('Target.closeTarget', { targetId });
    for (const tab of [...this.tabs.values()]) if (tab.targetId === targetId) this.forget(tab);
    await sleep(200);
    return { note: 'Closed the tab.', tabs: await this.listTabs({ owner }) };
  }

  async clickXY(x, y, o = {}) {
    const tab = await this.tabFor(o);
    const s = tab.shotScale || 1;
    await this.mouseClick(tab, x / s, y / s);
    await this.settle(tab, 500);
    return this.snapshot(o);
  }

  async evaluate(expression, o = {}) {
    const tab = await this.tabFor(o);
    return this.eval(tab, String(expression || 'undefined'));
  }

  /** JPEG of the tab's viewport, at most maxWidth wide; click_xy takes coordinates in it. */
  async screenshot({ quality = 70, maxWidth = 1280 } = {}, o = {}) {
    const tab = await this.tabFor(o);
    const m = await this.cdp.send('Page.getLayoutMetrics', {}, tab.sessionId);
    const vv = m.cssVisualViewport || m.visualViewport;
    const w = vv.clientWidth;
    const h = vv.clientHeight;
    let scale = Math.min(1, maxWidth / w);
    const capture = (s) => this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: vv.pageX, y: vv.pageY, width: w, height: h, scale: s } }, tab.sessionId, 20000);
    let r = await capture(scale);
    let size = imageSize(Buffer.from(r.data, 'base64'));
    // High-DPI screens capture at device pixels; shrink to keep the image small.
    if (size && size.width > maxWidth * 1.05) {
      scale *= maxWidth / size.width;
      r = await capture(scale);
      size = imageSize(Buffer.from(r.data, 'base64'));
    }
    const width = size?.width || Math.round(w * scale);
    tab.shotScale = width / w;
    return { data: r.data, mime: 'image/jpeg', width, height: size?.height || Math.round(h * scale), url: tab.url, title: tab.title, tab: tab.targetId.slice(0, 8) };
  }

  async close() {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp && !cdp.closed) {
      await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
      cdp.close();
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      setTimeout(() => {
        try {
          proc.kill();
        } catch { /* gone */ }
      }, 1500).unref?.();
    }
  }
}
