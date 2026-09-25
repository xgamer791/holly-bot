// Minimal Server-Sent Events reader for fetch() streams.

/**
 * Parse an SSE stream into { event, data } objects.
 * Handles CRLF, multi-line data fields, comments and a trailing event without a blank line.
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* readSSE(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      // Cancelled by the abort (onAbort): stopped, not finished.
      if (done && signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) {
        const chunk = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const evt = parseEvent(chunk);
        if (evt) yield evt;
      }
    }
    buf += decoder.decode();
    const evt = parseEvent(buf);
    if (evt) yield evt;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch { /* already released */ }
  }
}

export function parseEvent(chunk) {
  if (!chunk || !chunk.trim()) return null;
  let event = 'message';
  const data = [];
  for (const line of chunk.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}
