import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { Icon } from './icons.js';
import { tr } from './i18n.js';

const DRAWER_MS = 450;
/** How long past the end of a slide (ms) the drawer waits to go: nothing about
 * the app changes while it's still moving. */
const SETTLE_MS = 120;
/** How far a finger goes (px) before a touch counts as a swipe one way or the other. */
const SWIPE_SLOP = 8;
/** What a swipe that starts on these isn't for: they take a finger themselves. */
const OWN_TOUCH = 'input, textarea, select, [contenteditable]';
/** A click this soon (ms) after a swipe ends is the swipe's, not a tap. */
const SWIPE_CLICK_MS = 400;
/** The touch a swipe follows, among those a touch event is about. */
const touchOf = (e, id) => Array.prototype.find.call(e.changedTouches, (t) => t.identifier === id);

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The drawer's width: styles.css --drawer-w, measured once it's on screen. */
const drawerWidth = () => document.querySelector('.sheet.drawer')?.offsetWidth || Math.min(innerWidth - 70, 560);

/** The drawer on screen (useDrawer), for a swipe that pulled it out to hand over to. */
const drawers = { current: null };

/**
 * Where the drawer is while a finger moves it: how far from fully open (px, 0
 * or less), for styles.css (--drawer-drag, and --drawer-shown for the app's
 * dimming). Set at most once a frame, however often the finger reports in;
 * `now` sets it at once. null lets the page's classes place it again.
 */
let placing = 0;
let placeTo = null;
function applyPlace() {
  placing = 0;
  const style = document.documentElement.style;
  style.setProperty('--drawer-drag', `${placeTo.drag}px`);
  style.setProperty('--drawer-shown', String(Math.max(0, 1 + placeTo.drag / placeTo.w)));
}
function place(drag, w, now = false) {
  if (drag == null) {
    cancelAnimationFrame(placing);
    placing = 0;
    document.documentElement.style.removeProperty('--drawer-drag');
    document.documentElement.style.removeProperty('--drawer-shown');
    return;
  }
  placeTo = { drag, w };
  if (now) {
    cancelAnimationFrame(placing);
    applyPlace();
  } else if (!placing) {
    placing = requestAnimationFrame(applyPlace);
  }
}

/** A finger's sideways speed (px/ms), over its last 100 ms. */
function tracker(x, t) {
  const points = [{ x, t }];
  return {
    add(x2, t2) {
      points.push({ x: x2, t: t2 });
      while (points.length > 2 && t2 - points[0].t > 100) points.shift();
    },
    speed() {
      const a = points[0];
      const b = points[points.length - 1];
      return b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
    },
  };
}

/** How long the rest of the way takes after a swipe: `distance` px to go of a
 * drawer `w` wide, the finger going `v` px/ms. The part of a whole slide that's
 * left, and no slower than the finger: an ease-out (styles.css --drawer-in)
 * starts about four times faster than it goes on average. */
function settleMs(distance, v, w) {
  if (reduceMotion()) return 0;
  const d = Math.abs(distance);
  let ms = DRAWER_MS * Math.min(1, d / w);
  if (Math.abs(v) > 0.05) ms = Math.min(ms, (4 * d) / Math.abs(v));
  return Math.round(Math.min(DRAWER_MS, Math.max(180, ms)));
}

/** The next slide takes `ms` (styles.css --drawer-ms), then back to 450 ms. */
let slideTimer = 0;
function slideFor(ms) {
  const style = document.documentElement.style;
  clearTimeout(slideTimer);
  style.setProperty('--drawer-ms', `${ms}ms`);
  slideTimer = setTimeout(() => style.removeProperty('--drawer-ms'), ms + SETTLE_MS);
}

/**
 * The drawer has gone and the app has slid back: for a couple of frames the
 * app isn't a layer of its own (styles.css .drawer-gone), which draws it
 * afresh where it is. As a layer the whole time, iOS could leave it drawn
 * where the drawer had pushed it, over on the right with nothing beside it.
 */
function redrawApp() {
  const root = document.documentElement;
  root.classList.add('drawer-gone');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('drawer-gone')));
}

/**
 * A sheet as a drawer from the left (Settings; pass it to Sheet as `drawer`).
 * It slides in pushing the app over to the right, and slides back out pulling
 * the app back, 450 ms each; `close` plays that and then, once it's surely
 * over, calls `remove` (at once with Reduce Motion on). The page's
 * `drawer-open` class says where it is, so every move carries on from
 * wherever it is (styles.css → .sheet.drawer).
 * Swiping left on it, or on the strip of the app beside it, pushes it back,
 * following the finger: let go a third of the way over, or with a flick, and it
 * closes, otherwise it slides back open. A tap on the strip closes it. (Swiping
 * right on the chat list pulls it out: useDrawerPull.) Swipes are touch events,
 * which a sideways swipe keeps from the page (preventDefault): pointer events
 * get cancelled on iOS as soon as the page takes the touch for anything else.
 */
export function useDrawer(remove) {
  const ref = useRef(null);
  const timer = useRef(null);
  const swipe = useRef(null);
  const swipedAt = useRef(-Infinity); // when a swipe ended: a click it makes isn't a tap
  const root = document.documentElement;
  const close = ({ ms = reduceMotion() ? 0 : DRAWER_MS, flung = false } = {}) => {
    if (timer.current) return;
    // Let go of mid-swipe: already moving, so it carries on out easing off.
    if (flung) {
      root.classList.add('drawer-flung');
      slideFor(ms);
    }
    root.classList.remove('drawer-open', 'drawer-dragging');
    place(null);
    timer.current = setTimeout(() => remove?.(), ms && ms + SETTLE_MS);
  };
  const api = useRef({}).current;
  api.close = close;
  useEffect(() => {
    drawers.current = api;
    // It (and the app's dimming) has been drawn closed once, so there's
    // somewhere to slide and fade in from. Pulled out by a swipe, it's
    // already where the finger is.
    root.classList.add('drawer-mounted');
    ref.current?.getBoundingClientRect();
    root.classList.add('drawer-open');
    return () => {
      if (drawers.current === api) drawers.current = null;
      clearTimeout(timer.current);
      root.classList.remove('drawer-mounted', 'drawer-open', 'drawer-dragging', 'drawer-flung');
      place(null);
      redrawApp();
    };
  }, []);
  const end = (e, up) => {
    const s = swipe.current;
    if (!s || !touchOf(e, s.id)) return;
    swipe.current = null;
    if (!s.sideways) return;
    swipedAt.current = performance.now();
    const v = up ? s.speed.speed() : 0;
    if (v < -0.4 || (s.drag < -s.w / 3 && v < 0.4)) return close({ flung: true, ms: settleMs(s.w + s.drag, v, s.w) });
    slideFor(settleMs(s.drag, v, s.w));
    root.classList.remove('drawer-dragging');
    place(null);
  };
  // On the drawer and on the strip beside it.
  const handlers = {
    onTouchStart(e) {
      if (swipe.current?.sideways) return; // another finger, mid-swipe
      swipe.current = null;
      if (e.touches.length !== 1 || timer.current || !ref.current || e.target.closest?.(OWN_TOUCH)) return;
      const t = e.touches[0];
      swipe.current = { id: t.identifier, x: t.clientX, y: t.clientY, w: ref.current.offsetWidth, drag: 0, sideways: null, speed: tracker(t.clientX, e.timeStamp) };
    },
    onTouchMove(e) {
      const s = swipe.current;
      const t = s && touchOf(e, s.id);
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (s.sideways === null) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
        // Up and down is the drawer's scrolling; only a swipe to the left moves it.
        if (!(dx < 0 && Math.abs(dx) > Math.abs(dy))) {
          swipe.current = null;
          return;
        }
        s.sideways = true;
        root.classList.add('drawer-dragging');
      }
      if (e.cancelable) e.preventDefault();
      s.speed.add(t.clientX, e.timeStamp);
      s.drag = Math.max(-s.w, Math.min(0, dx));
      place(s.drag, s.w);
    },
    onTouchEnd: (e) => end(e, true),
    onTouchCancel: (e) => end(e, false),
    onClickCapture(e) {
      if (performance.now() - swipedAt.current > SWIPE_CLICK_MS) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
  };
  return { ref, close, handlers };
}

/**
 * Swiping right on the chat list pulls the drawer (Settings) out from the left,
 * following the finger: let go a third of the way out, or with a flick, and it
 * opens, otherwise it slides back. `open()` puts the drawer on screen and gives
 * its sheet's id, `dismiss(id)` takes it off again; up-and-down moves are left
 * to the list's scrolling, and a touch while `busy()` (a chat showing Delete)
 * isn't for the drawer. Returns the handlers for the list.
 */
export function useDrawerPull(open, dismiss, busy) {
  const pull = useRef(null);
  const pulledAt = useRef(-Infinity); // when a swipe ended: a click it makes isn't a tap
  const root = document.documentElement;
  const end = (e, up) => {
    const p = pull.current;
    if (!p || !touchOf(e, p.id)) return;
    pull.current = null;
    if (!p.on) return;
    pulledAt.current = performance.now();
    const v = up ? p.speed.speed() : 0;
    if (v > 0.4 || (p.drag > -p.w * (2 / 3) && v > -0.4)) {
      // The rest of the way out.
      slideFor(settleMs(p.drag, v, p.w));
      root.classList.remove('drawer-dragging');
      place(null);
      return;
    }
    const ms = settleMs(p.w + p.drag, v, p.w);
    if (drawers.current) return drawers.current.close({ flung: true, ms });
    // Let go of before the drawer got there: it isn't wanted after all.
    dismiss(p.sheet);
    root.classList.add('drawer-flung');
    slideFor(ms);
    root.classList.remove('drawer-open', 'drawer-dragging');
    place(null);
    setTimeout(() => {
      if (drawers.current) return;
      root.classList.remove('drawer-mounted', 'drawer-flung');
      redrawApp();
    }, ms + SETTLE_MS);
  };
  return {
    onTouchStart(e) {
      if (pull.current?.on) return; // another finger, mid-swipe
      pull.current = null;
      if (e.touches.length !== 1 || busy() || root.classList.contains('drawer-mounted') || e.target.closest?.(OWN_TOUCH)) return;
      const t = e.touches[0];
      pull.current = { id: t.identifier, x: t.clientX, y: t.clientY, on: null, drag: 0, w: 0, sheet: null, speed: tracker(t.clientX, e.timeStamp) };
    },
    onTouchMove(e) {
      const p = pull.current;
      const t = p && touchOf(e, p.id);
      if (!t) return;
      const dx = t.clientX - p.x;
      const dy = t.clientY - p.y;
      if (p.on === null) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
        if (!(dx > 0 && Math.abs(dx) > Math.abs(dy))) {
          pull.current = null;
          return;
        }
        // Where the finger is before the drawer is there, so the app doesn't jump.
        p.on = true;
        p.w = drawerWidth();
        p.drag = Math.min(0, dx - p.w);
        place(p.drag, p.w, true);
        root.classList.add('drawer-mounted', 'drawer-open', 'drawer-dragging');
        p.sheet = open();
      }
      if (e.cancelable) e.preventDefault();
      p.speed.add(t.clientX, e.timeStamp);
      p.drag = Math.max(-p.w, Math.min(0, dx - p.w));
      place(p.drag, p.w);
    },
    onTouchEnd: (e) => end(e, true),
    onTouchCancel: (e) => end(e, false),
    onClickCapture(e) {
      if (performance.now() - pulledAt.current > SWIPE_CLICK_MS) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
  };
}

export function Sheet({ title, onClose, children, footer, left, right, className = '', headless = false, drawer = null }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`
    <div class=${`sheet-scrim ${drawer ? 'drawer-scrim' : ''}`} onClick=${onClose} ...${drawer?.handlers}></div>
    <section ref=${drawer?.ref} class=${`sheet ${className} ${drawer ? 'drawer' : ''} ${headless ? 'headless' : ''}`} role="dialog" aria-modal="true" aria-label=${title || tr('Sheet')} ...${drawer?.handlers}>
      ${drawer && html`<button class="sr-only" onClick=${onClose}>${tr('Close')}</button>`}
      ${!headless && html`
        <header class="sheet-head">
          ${left || html`<button class="circle-btn" aria-label=${tr('Close')} onClick=${onClose}><${Icon.x} /></button>`}
          <h2>${title}</h2>
          ${right}
        </header>`}
      <div class="sheet-body">${children}</div>
      ${footer && html`<footer class="sheet-foot">${footer}</footer>`}
    </section>`;
}

export function Toggle({ on, onChange, small = false, label }) {
  return html`<button class=${`toggle ${small ? 'small' : ''} ${on ? 'on' : ''}`} role="switch" aria-checked=${!!on} aria-label=${label}
    onClick=${(e) => {
      e.stopPropagation();
      onChange?.(!on);
    }}></button>`;
}

export function Group({ label, note, children }) {
  return html`
    ${label && html`<div class="group-label">${label}</div>`}
    <div class="group">${children}</div>
    ${note && html`<div class="group-note">${note}</div>`}`;
}

/** iOS-style row: title/subtitle on the left, value/toggle/chevron on the right. */
export function Row({ title, sub, value, onClick, chevron = !!onClick, toggle, onToggle, danger, center, children, icon }) {
  const content = html`
    ${icon}
    <div class="label"><div class="t">${title}</div>${sub && html`<div class="s">${sub}</div>`}</div>
    ${value != null && value !== '' && html`<div class="value">${value}</div>`}
    ${children}
    ${toggle !== undefined && html`<${Toggle} on=${toggle} onChange=${onToggle} label=${title} />`}
    ${chevron && html`<${Icon.chevron} class="chev" />`}`;
  const cls = `row ${danger ? 'danger' : ''} ${center ? 'center' : ''}`;
  if (onClick) return html`<button class=${cls} onClick=${onClick}>${content}</button>`;
  return html`<div class=${cls}>${content}</div>`;
}

export function Segmented({ options, value, onChange }) {
  return html`<div class="segmented" role="tablist">
    ${options.map((o) => html`<button role="tab" aria-selected=${value === o.value} class=${value === o.value ? 'on' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function Tabs({ tabs, value, onChange }) {
  return html`<div class="tabs" role="tablist">
    ${tabs.map((t) => html`<button role="tab" aria-selected=${value === t.value} class=${`tab ${value === t.value ? 'on' : ''}`} onClick=${() => onChange(t.value)}>${t.label}</button>`)}
  </div>`;
}

export function Field({ label, hint, children }) {
  return html`<div class="field">${label && html`<label>${label}</label>`}${children}${hint && html`<div class="hint">${hint}</div>`}</div>`;
}

export function Spinner() {
  return html`<span class="spinner" aria-label=${tr('Loading')}></span>`;
}

/** Popover menu anchored to an element rect. */
export function Popover({ anchor, onClose, items, align = 'right', from = 'top' }) {
  const style = (() => {
    if (!anchor) return '';
    const r = anchor.getBoundingClientRect();
    const vw = innerWidth;
    if (from === 'bottom') return `left:${Math.max(8, r.left)}px;bottom:${innerHeight - r.top + 10}px`;
    return align === 'right' ? `right:${Math.max(8, vw - r.right)}px;top:${r.bottom + 8}px` : `left:${r.left}px;top:${r.bottom + 8}px`;
  })();
  return html`
    <div class="popover-scrim" onClick=${onClose}></div>
    <div class=${`popover ${from === 'bottom' ? 'from-bottom' : ''}`} style=${style} role="menu">
      ${items.map((it) => html`<button role="menuitem" onClick=${() => {
        onClose();
        it.onClick();
      }}>${it.icon && html`<${it.icon} />`}<span>${it.label}</span></button>`)}
    </div>`;
}

export function Dialog({ title, message, confirmText = tr('OK'), cancelText = tr('Cancel'), danger, onResult, input }) {
  const [value, setValue] = useState(input?.value || '');
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return html`
    <div class="dialog-scrim" onClick=${() => onResult(null)}>
      <div class="dialog" onClick=${(e) => e.stopPropagation()} role="alertdialog" aria-label=${title}>
        <h3>${title}</h3>
        ${message && html`<p>${message}</p>`}
        ${input && html`<input ref=${ref} class="input" style="margin-bottom:16px" value=${value} placeholder=${input.placeholder || ''}
          type=${input.type || 'text'} autocomplete="off" autocapitalize="off" spellcheck=${false}
          onInput=${(e) => setValue(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && onResult(value)} />`}
        <div class="btn-row">
          ${cancelText && html`<button class="btn" onClick=${() => onResult(null)}>${cancelText}</button>`}
          <button class=${`btn ${danger ? 'danger' : 'primary'}`} onClick=${() => onResult(input ? value : true)}>${confirmText}</button>
        </div>
      </div>
    </div>`;
}

export function Toasts({ toasts, onDismiss }) {
  return html`<div class="toasts" aria-live="polite">
    ${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.error ? 'err' : ''}`}>
      <span>${t.text}</span>
      ${t.action && html`<button onClick=${() => {
        onDismiss(t.id);
        t.action.onClick();
      }}>${t.action.label}</button>`}
    </div>`)}
  </div>`;
}

export function copyText(text) {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
