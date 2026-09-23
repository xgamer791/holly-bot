import { html, useEffect, useMemo, useRef } from '../../vendor/preact.js';
import { marked, DOMPurify } from '../../vendor/markdown.js';

marked.setOptions({ gfm: true, breaks: true });

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
    for (const pre of ref.current.querySelectorAll('pre')) {
      if (pre.querySelector('.copy-code')) continue;
      const b = document.createElement('button');
      b.className = 'copy-code';
      b.textContent = 'Copy';
      b.onclick = () => {
        navigator.clipboard?.writeText(pre.querySelector('code')?.innerText || pre.innerText).then(() => {
          b.textContent = 'Copied';
          setTimeout(() => { b.textContent = 'Copy'; }, 1400);
        });
      };
      pre.appendChild(b);
    }
  }, [markup, streaming]);
  return html`<div ref=${ref} class=${`md ${streaming ? 'cursor-host' : ''} ${className}`} dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}
