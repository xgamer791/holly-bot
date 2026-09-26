import { html, useState, useEffect, useLayoutEffect, useRef } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, useTopics } from './hooks.js';
import { Sheet, Tabs, downloadBlob, Group, Row } from './components.js';
import { Icon, fileIcon } from './icons.js';
import { Markdown } from './markdown.js';
import { formatBytes, truncate } from '../core/util.js';
import { fileToBlob, isTextPath } from '../core/files.js';
import { dateTimeText, mark, number, phraseOr, shortTime, tr, trn, trx } from './i18n.js';

/** The capabilities the computer's About tab lists, by name. */
const CAPABILITIES = {
  shell: mark('Shell'), files: mark('Files'), fetch: mark('Fetch'), search: mark('Search'),
  screenshot: mark('Screenshot'), browser: mark('Browser'), mcp: 'MCP',
};

export function ComputerSheet({ agentId, onClose, fileId: initialFile, tab: initialTab }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['computer', 'settings', 'agents', 'runs']);
  const agent = agentId ? app.getAgent(agentId) : null;
  const connected = app.computer.connected;
  const caps = app.computer.info?.capabilities || {};
  const canScreen = connected && (caps.screenshot || caps.browser);
  const [tab, setTab] = useState(initialTab || (initialFile ? 'files' : canScreen ? 'screen' : agent ? 'files' : 'about'));
  const [openFile, setOpenFile] = useState(initialFile || null);
  const busy = app.runtime.activeRuns().length;
  const tabs = [
    ...(canScreen ? [{ value: 'screen', label: tr('Screen') }] : []),
    ...(agent ? [{ value: 'files', label: tr('Files') }, { value: 'activity', label: tr('Activity') }] : []),
    ...(connected ? [{ value: 'terminal', label: tr('Terminal') }] : []),
    { value: 'about', label: connected ? app.computer.info?.hostname || tr('Computer') : tr('Set up') },
  ];
  return html`
    <${Sheet} title=${agent ? tr("{name}'s computer", { name: agent.name }) : tr('Computer')} onClose=${onClose}
      footer=${tab === 'screen' && caps.memory ? html`<${RamMeter} />` : null}
      right=${busy ? html`<button class="btn small danger" onClick=${() => Promise.resolve(app.runtime.stopAll()).then(() => ui.toast(tr('Stopped all bots')), (err) => ui.toast(err.message, { error: true }))}>${tr('Stop all')}</button>`
        : html`<span class=${`status-pill ${connected ? 'ok' : ''}`}><span class="d"></span>${connected ? tr('Online') : tr('Browser only')}</span>`}>
      <${Tabs} value=${tab} onChange=${(t) => { setTab(t); setOpenFile(null); }} tabs=${tabs} />
      ${tab === 'screen' && html`<${Screen} agentId=${agent?.id} />`}
      ${tab === 'files' && agent && (openFile
        ? html`<${FilePreview} fileId=${openFile} onBack=${() => setOpenFile(null)} />`
        : html`<${FileList} agentId=${agentId} onOpen=${setOpenFile} />`)}
      ${tab === 'files' && !agent && openFile && html`<${FilePreview} fileId=${openFile} />`}
      ${tab === 'activity' && agent && html`<${ActivityLog} agentId=${agentId} />`}
      ${tab === 'terminal' && html`<${Terminal} />`}
      ${tab === 'about' && html`<${ComputerAbout} onSetup=${() => ui.openSheet('settings', { page: 'computer' })} />`}
    <//>`;
}

function FileList({ agentId, onOpen }) {
  const app = useApp();
  const ui = useUi();
  const input = useRef(null);
  const { data: files = [] } = useAsync(() => app.files.list(agentId), [agentId], [`files:${agentId}`]);
  const upload = async (list) => {
    for (const f of list) {
      await app.files.write(agentId, `uploads/${f.name}`, f, { mime: f.type, source: 'user' });
    }
    ui.toast(trn(list.length, 'Uploaded {n} file', 'Uploaded {n} files'));
  };
  return html`
    <div class="btn-row" style="margin:6px 0 10px">
      <button class="btn small" onClick=${() => input.current.click()}><${Icon.upload} size="16" /> ${tr('Upload')}</button>
      <span class="hint" style="align-self:center">${trn(files.length, '{n} file', '{n} files')} · ${formatBytes(files.reduce((s, f) => s + (f.size || 0), 0))}</span>
    </div>
    <input ref=${input} type="file" multiple hidden onChange=${(e) => { upload([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
    ${!files.length && html`<div class="empty-home" style="padding:40px 10px"><p>${tr('No files yet. Your bot creates files here when it writes reports, code, charts or images — and you can upload files for it to use.')}</p></div>`}
    ${files.map((f) => {
      const Ic = fileIcon(f.mime, f.path);
      return html`<button class="file-row" key=${f.id} onClick=${() => onOpen(f.id)}>
        <span class="fi"><${Ic} /></span>
        <span class="n"><div>${f.path}</div><div>${formatBytes(f.size)} · ${shortTime(f.updatedAt)}${f.source === 'user' ? ` · ${tr('uploaded')}` : ''}</div></span>
        <${Icon.chevron} size="16" />
      </button>`;
    })}`;
}

export function FilePreview({ fileId, onBack }) {
  const app = useApp();
  const ui = useUi();
  const { data: file, loading } = useAsync(() => app.files.getById(fileId), [fileId]);
  const [url, setUrl] = useState(null);
  const [text, setText] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    let u = null;
    (async () => {
      if (file.text != null) setText(file.text);
      else if (file.blob && isTextPath(file.path, file.mime)) setText(await file.blob.text());
      if (file.blob || /html|svg/.test(file.mime)) {
        u = URL.createObjectURL(await fileToBlob(file));
        setUrl(u);
      }
    })();
    return () => u && URL.revokeObjectURL(u);
  }, [file]);
  if (loading) return html`<div class="notice">${tr('Loading…')}</div>`;
  if (!file) return html`<div class="notice">${tr('File not found.')}</div>`;
  const isImage = file.mime?.startsWith('image/') && file.mime !== 'image/svg+xml';
  const isHtml = /html/.test(file.mime) || /\.html?$/i.test(file.path);
  const isMd = /markdown/.test(file.mime) || /\.md$/i.test(file.path);
  const isPdf = file.mime === 'application/pdf';
  return html`
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px">
      ${onBack && html`<button class="circle-btn" aria-label=${tr('Back to files')} onClick=${onBack}><${Icon.back} /></button>`}
      <div style="flex:1;min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file.path}</div>
        <div class="hint">${file.mime} · ${formatBytes(file.size)} · ${dateTimeText(file.updatedAt)}</div></div>
    </div>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn small" onClick=${async () => downloadBlob(await fileToBlob(file), file.path.split('/').pop())}><${Icon.download} size="16" /> ${tr('Download')}</button>
      ${(isHtml || isPdf) && url && html`<a class="btn small" href=${url} target="_blank" rel="noopener">${tr('Open')}</a>`}
      <button class="btn small danger" onClick=${async () => {
        if (await ui.confirm({ title: tr('Delete {name}?', { name: file.path }), confirmText: tr('Delete'), danger: true })) {
          await app.files.remove(file.agentId, file.path);
          onBack?.();
        }
      }}><${Icon.trash} size="16" /> ${tr('Delete')}</button>
    </div>
    ${isImage && url && html`<img src=${url} alt=${file.path} style="max-width:100%;border-radius:14px" />`}
    ${isHtml && text != null && html`<iframe class="preview-frame" sandbox="allow-scripts allow-forms allow-modals" srcdoc=${text} title=${file.path}></iframe>`}
    ${isPdf && url && html`<iframe class="preview-frame" src=${url} title=${file.path}></iframe>`}
    ${isMd && text != null && html`<div class="bubble plain-bot" style="max-width:100%"><${Markdown} text=${text} /></div>`}
    ${!isImage && !isHtml && !isMd && !isPdf && text != null && html`<div class="preview-text">${truncate(text, 200000)}</div>`}
    ${!isImage && !isHtml && !isPdf && text == null && html`<div class="notice">${tr('No preview for this file type.')}</div>`}`;
}

function ActivityLog({ agentId }) {
  const app = useApp();
  const { data: rows = [] } = useAsync(() => app.loadActivity(agentId, 150), [agentId], ['activity']);
  if (!rows.length) return html`<div class="empty-home" style="padding:40px 10px"><p>${tr('Nothing yet. Tool use, commands, file changes and browsing show up here.')}</p></div>`;
  return html`${rows.map((r) => html`<div class="act-item" key=${r.id}>
    <div class="when">${shortTime(r.createdAt)}</div>
    <div class="what"><div style=${r.isError ? 'color:var(--red)' : ''}>${phraseOr(r.say, r.title)}</div>${r.detail && html`<div class="d">${r.detail}</div>`}</div>
  </div>`)}`;
}

function Terminal() {
  const app = useApp();
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  const run = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setCmd('');
    const ctrl = new AbortController();
    setRunning(ctrl);
    setLog((l) => [...l, { t: 'cmd', v: c }]);
    try {
      const res = await app.computer.exec(c, {
        signal: ctrl.signal,
        onData: (stream, chunk) => setLog((l) => [...l, { t: stream, v: chunk }]),
      });
      setLog((l) => [...l, { t: 'exit', v: `[exit ${res.code}]` }]);
    } catch (err) {
      setLog((l) => [...l, { t: 'stderr', v: err.message }]);
    } finally {
      setRunning(null);
    }
  };
  const info = app.computer.info || {};
  return html`
    <div class="hint" style="margin:4px 4px 8px">${tr('Commands you type here run on {computer} ({shell}) in {folder}.', { computer: info.hostname || tr('your computer'), shell: info.shell || tr('shell'), folder: info.workspace || info.cwd || tr('the workspace') })}</div>
    <div class="terminal" ref=${ref} style="min-height:240px;max-height:48vh">${log.map((e, i) => (e.t === 'cmd'
      ? html`<span key=${i} class="cmd">\n$ ${e.v}\n</span>`
      : html`<span key=${i} class=${e.t === 'stderr' ? 'err' : e.t === 'exit' ? 'cmd' : ''}>${e.v}${e.t === 'exit' ? '\n' : ''}</span>`))}</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input class="input mono" placeholder=${tr('Type a command')} value=${cmd} onInput=${(e) => setCmd(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && run()} autocapitalize="off" autocorrect="off" spellcheck="false" />
      ${running ? html`<button class="btn" onClick=${() => running.abort()}>${tr('Stop')}</button>` : html`<button class="btn primary" onClick=${run}>${tr('Run')}</button>`}
    </div>`;
}

/** How far the screen picture zooms in. */
const MAX_ZOOM = 6;

const fitZoom = (z) => Math.min(MAX_ZOOM, Math.max(1, z));

/**
 * Zooming the screen picture inside its frame, not the page: a pinch (or
 * ctrl + scroll, or a trackpad pinch) zooms it, and zoomed in, a finger, the
 * mouse or scrolling moves it around. Until it's zoomed in, one finger on it
 * scrolls the sheet as before.
 *
 * The view is { z, x, y }: the zoom, and where the picture's top-left corner
 * is, as a share of the frame's width and height (from 1 − z to 0). The
 * picture is laid out at its zoomed size rather than scaled with a
 * transform, so the browser draws it from the full image at every zoom and
 * it stays sharp. `onSettle` is called when a gesture has zoomed or moved it.
 */
function useZoom(onSettle) {
  const frame = useRef(null);
  const picture = useRef(null);
  const view = useRef({ z: 1, x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const quietUntil = useRef(0); // the click at the end of a pinch or a drag isn't a tap
  const drag = useRef(null);
  const settled = useRef(onSettle);
  settled.current = onSettle;

  const paint = () => {
    const s = picture.current?.style;
    if (!s) return;
    const { z, x, y } = view.current;
    s.width = `${z * 100}%`;
    s.height = `${z * 100}%`;
    s.left = `${x * 100}%`;
    s.top = `${y * 100}%`;
  };
  const place = (z, x, y) => {
    view.current = { z, x: Math.min(0, Math.max(1 - z, x)), y: Math.min(0, Math.max(1 - z, y)) };
    paint();
  };
  /** Zooms to `z` from `from`, keeping the point of the picture at (fx, fy) of the frame where it is. */
  const zoomAt = (z, fx, fy, from = view.current) => {
    const to = fitZoom(z);
    place(to, fx - ((fx - from.x) / from.z) * to, fy - ((fy - from.y) / from.z) * to);
  };
  /** A gesture is over. `fingers`: it was a pinch or a drag, and the click that may follow isn't a tap. */
  const settle = (fingers = true) => {
    if (fingers) quietUntil.current = performance.now() + 400;
    if (view.current.z < 1.05) place(1, 0, 0);
    setZoom(view.current.z);
    settled.current?.(view.current.z);
  };
  const reset = () => {
    place(1, 0, 0);
    setZoom(1);
  };

  // A picture put in (a new one, after none) starts where the view is.
  useLayoutEffect(paint);

  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    let g = null; // the touches: where they started (p), the view then (v), and whether they've zoomed or moved it
    let pinch = null; // a trackpad pinch in Safari
    let wheelEnd = 0;
    const at = (touches, rect) => {
      const a = touches[0];
      const b = touches[1] || a;
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      return { n: touches.length, cx, cy, x: (cx - rect.left) / rect.width, y: (cy - rect.top) / rect.height, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    };
    // Each time a finger lands or lifts, the gesture carries on from where the picture is.
    const begin = (e) => {
      const rect = el.getBoundingClientRect();
      g = { rect, p: at(e.touches, rect), v: view.current, moved: !!g?.moved, pinched: !!g?.pinched || e.touches.length > 1 };
    };
    const move = (e) => {
      if (!g || !e.touches.length || !picture.current) return;
      if (e.touches.length !== g.p.n) return begin(e);
      const p = at(e.touches, g.rect);
      const far = Math.hypot(p.cx - g.p.cx, p.cy - g.p.cy) > 6;
      if (p.n > 1) {
        // Two fingers: the picture zooms, and the page doesn't.
        if (e.cancelable) e.preventDefault();
        g.moved = true;
        const z = fitZoom(g.v.z * (g.p.d ? p.d / g.p.d : 1));
        place(z, p.x - ((g.p.x - g.v.x) / g.v.z) * z, p.y - ((g.p.y - g.v.y) / g.v.z) * z);
      } else if (g.v.z > 1 && (g.moved || far)) {
        if (e.cancelable) e.preventDefault();
        g.moved = true;
        place(g.v.z, g.v.x + p.x - g.p.x, g.v.y + p.y - g.p.y);
      } else if (far) g.moved = true; // the sheet scrolls
    };
    const end = (e) => {
      if (!g) return;
      if (e.touches.length) return begin(e);
      const done = g;
      g = null;
      if (done.pinched || (done.moved && done.v.z > 1)) settle();
    };
    const wheel = (e) => {
      const { z, x, y } = view.current;
      if (!picture.current || (!e.ctrlKey && z <= 1)) return; // the page scrolls
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      // A trackpad pinch comes in small steps; a mouse wheel's are big, and each is held to about 1.5×.
      if (e.ctrlKey) zoomAt(z * Math.exp(-Math.max(-40, Math.min(40, e.deltaY * unit)) * 0.01), (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      else place(z, x - (e.deltaX * unit) / rect.width, y - (e.deltaY * unit) / rect.height);
      clearTimeout(wheelEnd);
      wheelEnd = setTimeout(() => settle(false), 250);
    };
    // Safari's own pinch events: on a phone the touches above do the zooming,
    // and these would zoom the page; on a Mac they're the trackpad's pinch.
    const gesture = (e) => {
      if (!picture.current) return;
      e.preventDefault();
      if (g) return;
      if (e.type === 'gesturestart') {
        const rect = el.getBoundingClientRect();
        pinch = { v: view.current, fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height };
      } else if (pinch && e.type === 'gesturechange') zoomAt(pinch.v.z * e.scale, pinch.fx, pinch.fy, pinch.v);
      else if (pinch && e.type === 'gestureend') {
        pinch = null;
        settle(false);
      }
    };
    const listeners = [['touchstart', begin], ['touchmove', move], ['touchend', end], ['touchcancel', end], ['wheel', wheel],
      ['gesturestart', gesture], ['gesturechange', gesture], ['gestureend', gesture]];
    for (const [type, fn] of listeners) el.addEventListener(type, fn, { passive: false });
    return () => {
      clearTimeout(wheelEnd);
      for (const [type, fn] of listeners) el.removeEventListener(type, fn);
    };
  }, []);

  // Zoomed in, the mouse drags the picture around.
  const onPointerDown = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || view.current.z <= 1) return;
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, v: view.current, rect: e.currentTarget.getBoundingClientRect(), moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) e.currentTarget.setPointerCapture?.(e.pointerId);
    d.moved = true;
    place(d.v.z, d.v.x + dx / d.rect.width, d.v.y + dy / d.rect.height);
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (d.moved) settle();
  };

  return {
    frame, picture, view, zoom, reset,
    /** Whether a click is the end of a pinch or a drag rather than a tap. */
    quiet: () => performance.now() < quietUntil.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}

/**
 * Handlers for a box under the screen picture. Tapped, iOS would scroll the
 * sheet to put the box in the middle of what the keyboard leaves, and the
 * picture would go out of sight. Instead a tap focuses the box where it is,
 * and once the keyboard is up the sheet scrolls just far enough to show the
 * box right above it (showAboveKeyboard), so the picture stays in view. A long
 * press or a drag is left to the phone.
 */
function useBoxAboveKeyboard() {
  const touch = useRef(null);
  return {
    onTouchStart: (e) => {
      const t = e.touches[0];
      touch.current = t ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
    },
    onTouchEnd: (e) => {
      const box = e.currentTarget;
      const start = touch.current;
      const t = e.changedTouches[0];
      touch.current = null;
      if (!start || !t || document.activeElement === box) return;
      if (e.timeStamp - start.at > 400 || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) return;
      e.preventDefault();
      box.focus({ preventScroll: true });
      box.setSelectionRange?.(box.value.length, box.value.length);
    },
    onFocus: (e) => showAboveKeyboard(e.currentTarget),
  };
}

/** While `box` has focus: its sheet makes room at the bottom for the keyboard
 * (--keyboard) and scrolls so the box sits just above the keyboard, and any
 * scroll of the whole page the phone made is undone. */
function showAboveKeyboard(box) {
  const vv = window.visualViewport;
  const body = box.closest('.sheet-body');
  if (!vv || !body) return;
  const fit = () => {
    if (document.activeElement !== box) return;
    const keyboard = Math.max(0, document.documentElement.clientHeight - vv.height);
    body.style.setProperty('--keyboard', `${keyboard}px`);
    if (window.scrollY) window.scrollTo(0, 0);
    // Down to just above the keyboard when it's hidden; up to there only while
    // a keyboard is up (nothing moves at a computer's own keyboard).
    const by = box.getBoundingClientRect().bottom + 12 - (vv.offsetTop + vv.height);
    if (by > 1 || (keyboard > 80 && by < -1)) body.scrollBy({ top: by, behavior: 'smooth' });
  };
  // The keyboard coming up resizes the visual viewport; in case it doesn't say so, once more after a moment.
  const later = setTimeout(fit, 450);
  vv.addEventListener('resize', fit);
  box.addEventListener('blur', () => {
    clearTimeout(later);
    vv.removeEventListener('resize', fit);
    body.style.removeProperty('--keyboard');
  }, { once: true });
}

/** What's in each screen's typing box (by bot), kept while the app is open:
 * switching tabs or closing the sheet doesn't lose it. */
const typingDrafts = new Map();

/** The computer's screen, or with `agentId`, that bot's: on a server each bot
 * has a screen of its own, with its own window of the shared Chrome
 * (computer/src/screens.mjs); elsewhere they share the one. */
function Screen({ agentId }) {
  const app = useApp();
  const ui = useUi();
  const caps = app.computer.info?.capabilities || {};
  const own = !!(caps.screens && agentId);
  const [mode, setMode] = useState(caps.screenshot ? 'desktop' : 'browser');
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);
  const [url, setUrl] = useState('');
  const [typing, setTyping] = useState(() => typingDrafts.get(agentId || '') || '');
  const [keys, setKeys] = useState('');
  useEffect(() => {
    typingDrafts.set(agentId || '', typing);
  }, [typing, agentId]);
  // What the box last typed into the field on the computer, while typing
  // still goes to that field; null once a tap on the screen, or a key that
  // can move to another field, may have sent it somewhere else.
  const typed = useRef(null);
  const sending = useRef(false);
  const aboveKeyboard = useBoxAboveKeyboard();
  const inflight = useRef(false);
  // Actions started, and those still on their way: the live view waits for
  // them (its pictures would take the connection from theirs), and a picture
  // it asked for before one started shows the screen from before it.
  const acts = useRef({ started: 0, going: 0 });
  const asked = useRef(0); // how wide a picture the last request asked for
  const sharper = useRef(false); // a sharper picture is wanted once the one on its way is in
  const allOfIt = useRef(false); // zoomed in, the computer sent all the pixels it has

  const [closed, setClosed] = useState(false);

  /** The picture to ask for: at the frame's size what it's always been; zoomed
   * in, enough pixels for the zoomed picture (the computer sends no more than
   * its screen has, and draws its browser bigger) at a high quality, so it
   * stays sharp. */
  const detail = () => {
    const z = zoom.view.current.z;
    if (z <= 1) return { maxWidth: 1280 };
    const px = (zoom.frame.current?.clientWidth || 400) * z * (globalThis.devicePixelRatio || 1);
    return { maxWidth: Math.min(3840, Math.max(1280, Math.ceil(px / 256) * 256)), quality: 92, sharp: true };
  };

  // Zoomed in further than the picture has pixels for: a sharper one, now.
  const zoom = useZoom(() => {
    if (detail().maxWidth <= asked.current || allOfIt.current) return;
    if (inflight.current) sharper.current = true;
    else latest.current(true);
  });

  /** Shows what came back (for the picture asked for as `d`). */
  const show = (r, desktop, d) => {
    const s = desktop ? r.screenshot || { data: r.base64, mime: r.mime, width: r.width, height: r.height } : null;
    if (desktop && s?.data) setShot({ ...s, mime: s.mime || 'image/jpeg' });
    if (!desktop) {
      setClosed(r.running === false);
      if (r.screenshot) setShot({ data: r.screenshot, mime: 'image/jpeg', width: r.width, height: r.height, url: r.url, title: r.title, tab: r.tab });
      if (r.url && document.activeElement?.name !== 'url') setUrl(r.url);
    }
    // Narrower than a zoomed-in view asked for: that's all the computer has.
    const width = desktop ? s?.data && s.width : r.screenshot && r.width;
    if (width) allOfIt.current = !!d.sharp && width < d.maxWidth * 0.9;
  };

  const refresh = async (quiet = false) => {
    if (inflight.current || acts.current.going) return;
    inflight.current = true;
    if (!quiet) setBusy(true);
    const d = detail();
    asked.current = d.maxWidth;
    const since = acts.current.started;
    try {
      // `show`: on a bot's own screen with nothing on it, its browser window opens (local-computer.mjs).
      const r = mode === 'desktop'
        ? await app.computer.desktopAction('screenshot', { ...d, agentId, show: own })
        : await app.computer.browser('screenshot', { ...d, ifRunning: true, agentId });
      if (acts.current.started === since) show(r, mode === 'desktop', d);
    } catch (err) {
      if (!quiet) ui.toast(err.message, { error: true });
      setLive(false);
    } finally {
      inflight.current = false;
      setBusy(false);
      if (sharper.current) {
        sharper.current = false;
        if (detail().maxWidth > asked.current) latest.current(true);
      }
    }
  };
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    setShot(null);
    zoom.reset();
    sharper.current = false;
    allOfIt.current = false;
    typed.current = null;
    refresh();
  }, [mode]);

  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(true), mode === 'desktop' ? 1500 : 2500);
    return () => clearInterval(t);
  }, [live, mode]);

  /** Does `action` on the screen showing; true once it's done. */
  const act = async (action, args = {}) => {
    setBusy(true);
    const n = ++acts.current.started;
    acts.current.going++;
    // x and y are in the picture showing; the one that comes back is as sharp as the view needs.
    const d = detail();
    asked.current = d.maxWidth;
    try {
      let r;
      if (mode === 'desktop') r = await app.computer.desktopAction(action, { ...args, ...d, imageWidth: shot?.width, agentId });
      else {
        // Act on the tab being shown; after that the view follows whichever tab the bots use.
        const tab = action === 'goto' && closed ? undefined : shot?.tab;
        r = await app.computer.browser(action, { ...args, ...d, imageWidth: shot?.width, tab, quick: true, withScreenshot: true, agentId });
      }
      // Another action started since (a tap, then Type): its picture is the one to show.
      if (acts.current.started === n) show(r, mode === 'desktop', d);
      return true;
    } catch (err) {
      ui.toast(err.message, { error: true });
      return false;
    } finally {
      acts.current.going--;
      setBusy(false);
    }
  };

  const onTap = (e) => {
    if (!shot?.width || zoom.quiet()) return;
    // Where on the picture, zoomed in or not.
    const rect = zoom.picture.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * shot.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * shot.height);
    typed.current = null;
    if (mode === 'desktop') act('click', { x, y });
    else act('click_xy', { x, y });
  };

  const press = (k) => (mode === 'desktop' ? act('key', { keys: k }) : act('press', { key: k }));
  /**
   * Types what's in the box into the field on the computer, and the box keeps
   * it: the two hold the same text. Pressed again, only what changed goes:
   * Backspaces for what was taken off the end, then what's new. After a tap on
   * the screen, or Enter, Tab, Esc or a shortcut, all of it goes again.
   */
  const typeNow = async () => {
    if (sending.current) return;
    const text = typing;
    const was = typed.current;
    let same = 0;
    if (was != null) while (same < was.length && same < text.length && was[same] === text[same]) same += 1;
    const erase = was == null ? 0 : was.length - same;
    const add = text.slice(same);
    if (!erase && !add) return;
    sending.current = true;
    try {
      if (erase) {
        if (!(await press(Array(erase).fill('Backspace').join(' ')))) return;
        typed.current = text.slice(0, same);
      }
      if (add && (await act(mode === 'desktop' ? 'type' : 'type_text', { text: add }))) typed.current = text;
    } finally {
      sending.current = false;
    }
  };
  /** Enter, Tab, Esc and ⌫. ⌫ takes the last character off the field, and off
   * the box too while the two hold the same text. */
  const pressButton = async (k) => {
    if (!(await press(k))) return;
    if (k !== 'Backspace') {
      typed.current = null;
      return;
    }
    const was = typed.current;
    if (!was) return;
    const now = was.slice(0, -1);
    typed.current = now;
    setTyping((t) => (t === was ? now : t));
  };
  const pressShortcut = () => {
    if (!keys) return;
    typed.current = null;
    press(keys);
    setKeys('');
  };
  const scroll = (direction) => (mode === 'desktop'
    ? act('scroll', { x: Math.round((shot?.width || 1280) / 2), y: Math.round((shot?.height || 800) / 2), direction, amount: 5 })
    : act('scroll', { direction }));

  return html`
    ${caps.browser && caps.screenshot && html`<div class="segmented" style="margin-bottom:10px">
      <button class=${mode === 'desktop' ? 'on' : ''} onClick=${() => setMode('desktop')}>${tr('Desktop')}</button>
      <button class=${mode === 'browser' ? 'on' : ''} onClick=${() => setMode('browser')}>${tr('Bot browser')}</button></div>`}
    ${mode === 'browser' && html`<div style="display:flex;gap:8px;margin-bottom:10px">
      <input class="input" name="url" type="url" inputmode="url" placeholder=${tr('Website or search')} value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && url && act('goto', { url })} autocapitalize="off" autocorrect="off" />
      <button class="btn" onClick=${() => act('goto', { url })}>${tr('Go')}</button></div>`}
    <div ref=${zoom.frame} class=${`screen-view${shot?.data ? '' : ' empty'}${zoom.zoom > 1 ? ' zoomed' : ''}`}
      style=${shot?.data ? `aspect-ratio:${shot.width || 16} / ${shot.height || 10}` : ''} onClick=${onTap} ...${zoom.handlers}>
      ${shot?.data ? html`<img ref=${zoom.picture} class="screen-img" alt=${tr('Computer screen — tap to click')} src=${`data:${shot.mime};base64,${shot.data}`} draggable="false" />`
        : html`<div class="notice" style="padding:60px 0">${busy ? tr('Connecting to the screen…') : mode === 'browser' && closed ? tr('The bot browser isn’t open. Type a website above to open it — or ask a bot to browse.') : tr('No picture yet.')}</div>`}
      ${shot?.data && zoom.zoom > 1 && html`<button class="screen-zoom" aria-label=${tr('Show the whole screen')} onClick=${(e) => { e.stopPropagation(); zoom.reset(); }}>${number(Math.round(zoom.zoom * 10) / 10)}×</button>`}
      ${busy && shot?.data && html`<span class="spinner" style="position:absolute;top:10px;right:10px"></span>`}
    </div>
    <div class="hint" style="margin:8px 4px">${tr('Tap the picture to click there.')} ${tr('Pinch to zoom.')} ${own
      ? (mode === 'browser' ? tr('Sign in to sites here and every bot is signed in: the browser\'s logins are shared.') : tr('This bot\'s own screen: each bot has one, and they share the computer\'s files, apps and logins.'))
      : (mode === 'browser' ? tr('Sign in to sites here for your bots — logins stay in the bot browser.') : tr('This is the live screen of your computer.'))}</div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <div class="type-box">
        <input class="input" placeholder=${tr('Type text…')} value=${typing} onInput=${(e) => setTyping(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && typeNow()} autocapitalize="off" autocorrect="off" ...${aboveKeyboard} />
        ${typing && html`<button class="type-clear" aria-label=${tr('Clear')} onClick=${() => setTyping('')}><${Icon.x} size="16" /></button>`}
      </div>
      <button class="btn" onClick=${typeNow}>${tr('Type')}</button>
    </div>
    <div class="btn-row" style="margin-top:8px">
      ${['Enter', 'Tab', 'Escape', 'Backspace'].map((k) => html`<button key=${k} class="btn small" aria-label=${k === 'Backspace' ? tr('Backspace') : undefined} onClick=${() => pressButton(k)}>${k === 'Backspace' ? html`<${Icon.backspace} size="18" />` : k === 'Escape' ? 'Esc' : k}</button>`)}
      <button class="btn small" onClick=${() => scroll('up')}>↑ ${tr('Scroll')}</button>
      <button class="btn small" onClick=${() => scroll('down')}>↓ ${tr('Scroll')}</button>
      ${mode === 'browser' && html`<button class="btn small" onClick=${() => { typed.current = null; act('back'); }}>${tr('Back')}</button>`}
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input class="input mono" placeholder=${tr('Shortcut, e.g. {keys}', { keys: app.computer.info?.platform === 'darwin' ? 'cmd+space' : 'ctrl+l, win' })} value=${keys} onInput=${(e) => setKeys(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && pressShortcut()} autocapitalize="off" ...${aboveKeyboard} />
      <button class="btn" disabled=${!keys} onClick=${pressShortcut}>${tr('Press')}</button>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn small" onClick=${() => setLive(!live)}>${live ? html`<${Icon.pause} size="14" /> ${tr('Pause live view')}` : html`<${Icon.play} size="14" /> ${tr('Live view')}`}</button>
      <button class="btn small" disabled=${busy} onClick=${() => refresh()}><${Icon.refresh} size="16" /> ${tr('Refresh')}</button>
    </div>`;
}

/** Memory in bytes as "812 MB", "3.8 GB" or "15 GB". */
function ramSize(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** How much of the computer's memory is in use, as its own system monitor
 * counts it (computer/src/memory.mjs), read every few seconds while shown:
 * pinned at the bottom of the computer sheet under the Screen tab. */
function RamMeter() {
  const app = useApp();
  const [mem, setMem] = useState(null);
  useEffect(() => {
    let reading = null;
    const read = async () => {
      if (reading || document.visibilityState !== 'visible') return;
      reading = new AbortController();
      try {
        setMem(await app.computer.memory({ signal: reading.signal }));
      } catch { /* keeps the last reading */ } finally {
        reading = null;
      }
    };
    read();
    const t = setInterval(read, 3000);
    return () => {
      clearInterval(t);
      reading?.abort();
    };
  }, []);
  // Until the first reading comes, it keeps its place, so nothing jumps.
  const known = mem?.total > 0;
  const share = known ? Math.min(1, Math.max(0, mem.used / mem.total)) : 0;
  const pct = Math.round(share * 100);
  const sizes = known ? { used: ramSize(mem.used), total: ramSize(mem.total) } : null;
  const text = known ? tr('{used} of {total}', sizes) : '';
  return html`
    <div class="ram-meter" role="meter" aria-label=${tr('Memory in use')} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}
      aria-valuetext=${known ? tr('{used} of {total} in use', sizes) : tr('Reading')}>
      <div class="ram-meter-head"><b>${tr('RAM')}</b><span>${known ? `${text} · ${pct}%` : '…'}</span></div>
      <div class="ram-meter-bar"><span class=${share >= 0.9 ? 'high' : share >= 0.75 ? 'mid' : ''} style=${`width:${pct}%`}></span></div>
      ${mem?.swapUsed > 0 && html`<div class="ram-meter-note">${tr('Swap: {used} of {total} in use', { used: ramSize(mem.swapUsed), total: ramSize(mem.swapTotal) })}</div>`}
    </div>`;
}

function ComputerAbout({ onSetup }) {
  const app = useApp();
  const info = app.computer.info;
  if (!app.computer.connected) {
    return html`
      <div class="welcome">
        <p>${tr('Right now this bot works entirely in your browser: its own drive, a Python/JavaScript sandbox, web search and memory.')}</p>
        <p>${trx('Connect a **Bot Computer** — your own PC, Mac, Linux box or server running the small {program} companion — to let bots run shell commands, edit files, use a real browser and local MCP plugins, with your approval for risky actions.', { program: html`<span class="kbd">holly-computer</span>` })}</p>
        ${app.computer.error && html`<p style="color:var(--red)">${app.computer.error}</p>`}
        <button class="btn primary" onClick=${onSetup}>${tr('Set up Bot Computer')}</button>
      </div>`;
  }
  const caps = info?.capabilities || {};
  return html`
    <${Group}>
      <${Row} title=${tr('Computer')} value=${info?.hostname || '—'} />
      <${Row} title=${tr('System')} value=${`${info?.os || info?.platform || ''} ${info?.arch || ''}`} />
      <${Row} title=${tr('Shell')} value=${info?.shell || '—'} />
      <${Row} title=${tr('Workspace')} value=${info?.workspace || info?.cwd || '—'} />
      <${Row} title=${tr('Time zone')} value=${info?.tz || '—'} />
      <${Row} title=${tr('Holly Bot Computer')} value=${info?.version || '—'} />
      ${info?.desktopApp && html`<${Row} title=${tr('Holly Bot for Windows')} value=${info.desktopApp} />`}
    <//>
    <${Group} label=${tr('Capabilities')}>
      ${['shell', 'files', 'fetch', 'search', 'screenshot', 'browser', 'mcp'].map((k) => html`<${Row} key=${k} title=${tr(CAPABILITIES[k])} value=${caps[k] ? tr('Yes') : tr('No')} />`)}
    <//>
    <button class="btn block" onClick=${onSetup}>${tr('Connection settings')}</button>`;
}
