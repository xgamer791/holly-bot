import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { Icon } from './icons.js';
import { tr } from './i18n.js';

export function Sheet({ title, onClose, children, footer, left, right, className = '', headless = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`
    <div class="sheet-scrim" onClick=${onClose}></div>
    <section class=${`sheet ${className}`} role="dialog" aria-modal="true" aria-label=${title || tr('Sheet')}>
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
