import { truncate, truncateMiddle } from '../util.js';

// Client-side web access. Most chat providers also get their own server-side
// search (xAI, Claude, OpenAI, OpenRouter); these tools cover the rest and add
// page reading. Backends: your Bot Computer (no CORS limits), Tavily, Exa,
// Brave (via computer), Jina Reader / Search.

export async function searchWeb(ctx, query, { max = 6, signal } = {}) {
  const s = ctx.app.settings.services || {};
  const errors = [];
  if (s.tavily?.apiKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.tavily.apiKey}` },
        body: JSON.stringify({ query, max_results: max, include_answer: false, search_depth: 'basic' }),
        signal,
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}`);
      const data = await res.json();
      return { engine: 'Tavily', results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })) };
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (s.exa?.apiKey) {
    try {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa.apiKey },
        body: JSON.stringify({ query, numResults: max, contents: { text: { maxCharacters: 600 } } }),
        signal,
      });
      if (!res.ok) throw new Error(`Exa ${res.status}`);
      const data = await res.json();
      return { engine: 'Exa', results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.text || r.summary || '' })) };
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (ctx.app.computer?.connected) {
    try {
      const data = await ctx.app.computer.search(query, { max, braveKey: s.brave?.apiKey, signal });
      return { engine: data.engine || 'Bot Computer', results: data.results || [] };
    } catch (err) {
      errors.push(`computer: ${err.message}`);
    }
  }
  if (s.jina?.apiKey) {
    try {
      const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${s.jina.apiKey}`, Accept: 'application/json', 'X-Respond-With': 'no-content' },
        signal,
      });
      if (!res.ok) throw new Error(`Jina ${res.status}`);
      const data = await res.json();
      return { engine: 'Jina', results: (data.data || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.description || truncate(r.content || '', 400) })) };
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.length ? `Search failed: ${errors.join('; ')}` : 'No search backend configured. Add a Tavily or Exa key (Settings → Plugins), connect a Bot Computer, or use a provider with built-in search.');
}

export function hasClientSearch(app) {
  const s = app.settings.services || {};
  return !!(s.tavily?.apiKey || s.exa?.apiKey || s.jina?.apiKey || app.computer?.connected);
}

export async function readUrl(ctx, url, { signal } = {}) {
  const errors = [];
  if (ctx.app.computer?.connected) {
    try {
      return await ctx.app.computer.fetchPage(url, { signal });
    } catch (err) {
      errors.push(`computer: ${err.message}`);
    }
  }
  try {
    const key = ctx.app.settings.services?.jina?.apiKey;
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal,
    });
    if (!res.ok) throw new Error(`reader ${res.status}`);
    const text = await res.text();
    return { url, title: text.match(/^Title:\s*(.+)$/m)?.[1] || url, text };
  } catch (err) {
    errors.push(err.message);
  }
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const raw = await res.text();
    return { url, title: url, text: /html/.test(type) ? htmlToText(raw) : raw };
  } catch (err) {
    errors.push(`direct: ${err.message}`);
  }
  throw new Error(`Could not read ${url} (${errors.join('; ')})`);
}

export function htmlToText(html) {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,iframe').forEach((n) => n.remove());
    return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export const webTools = [
  {
    name: 'web_search',
    group: 'web',
    label: (a) => `Searched “${truncate(a.query || '', 50)}”`,
    description: 'Search the web for current information. Returns titles, URLs and snippets; use fetch_url to read a result in full. Cite sources as markdown links.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    available: (app) => hasClientSearch(app),
    async run(args, ctx) {
      const { engine, results } = await searchWeb(ctx, args.query, { max: args.max_results || 6, signal: ctx.signal });
      if (!results.length) return { content: `No results for "${args.query}".` };
      return {
        content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${truncate((r.snippet || '').replace(/\s+/g, ' '), 400)}`).join('\n'),
        display: { kind: 'search', engine, query: args.query, results: results.map((r) => ({ title: r.title, url: r.url })) },
      };
    },
  },
  {
    name: 'fetch_url',
    group: 'web',
    label: (a) => `Read ${hostOf(a.url)}`,
    description: 'Fetch a web page (or text/JSON/CSV URL) and return its readable content as text/markdown.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer', minimum: 500, maximum: 80000 },
      },
      required: ['url'],
    },
    async run(args, ctx) {
      let url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const page = await readUrl(ctx, url, { signal: ctx.signal });
      return {
        content: `# ${page.title}\n${url}\n\n${truncateMiddle(page.text || '', args.max_chars || 24000)}`,
        display: { kind: 'page', url, title: page.title },
      };
    },
  },
];

function hostOf(u) {
  try {
    return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '');
  } catch {
    return 'a page';
  }
}
