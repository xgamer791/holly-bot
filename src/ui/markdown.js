import { html, useEffect, useMemo, useRef } from '../../vendor/preact.js';
import { marked, DOMPurify } from '../../vendor/markdown.js';
import { copyText } from './components.js';
import { tr } from './i18n.js';

marked.setOptions({ gfm: true, breaks: true });

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A code block gets a header row, its language on the left and Copy (added by
// Markdown below, once the reply is done) on the right, so the button never
// sits on the code. The row is there while streaming too, so nothing jumps.
marked.use({
  renderer: {
    code({ text, lang, escaped }) {
      const name = (lang || '').match(/^\S*/)[0];
      const code = (escaped ? text : escapeHtml(text)).replace(/\n$/, '');
      return `<div class="code-box"><div class="code-head"><span class="code-lang">${escapeHtml(name)}</span></div>`
        + `<pre><code${name ? ` class="language-${escapeHtml(name)}"` : ''}>${code}\n</code></pre></div>\n`;
    },
  },
});

// Lucide's copy and check (lucide.dev, ISC; see src/ui/icons.js).
const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
});

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    return DOMPurify.sanitize(marked.parse(String(text)), { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'] });
  } catch {
    return DOMPurify.sanitize(String(text).replace(/</g, '&lt;'));
  }
}

export function Markdown({ text, streaming = false, className = '' }) {
  const ref = useRef(null);
  const markup = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => {
    if (!ref.current || streaming) return;
    for (const head of ref.current.querySelectorAll('.code-head')) {
      if (head.querySelector('.copy-code')) continue;
      const code = head.nextElementSibling;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'copy-code';
      const show = (done) => { b.innerHTML = `${done ? CHECK_ICON : COPY_ICON}<span>${done ? tr('Copied') : tr('Copy')}</span>`; };
      show(false);
      b.onclick = (e) => {
        e.stopPropagation(); // an agent card opens and closes on a tap
        copyText(code.innerText.replace(/\n$/, '')).then(() => {
          show(true);
          setTimeout(() => show(false), 1400);
        });
      };
      head.appendChild(b);
    }
  }, [markup, streaming]);
  return html`<div ref=${ref} class=${`md ${streaming ? 'cursor-host' : ''} ${className}`} dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}
