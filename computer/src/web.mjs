// Web access from the computer (no browser CORS limits): page → readable text,
// and keyless web search (DuckDuckGo HTML) or Brave Search with a key.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 HolliBot/1.0';
const MAX_BYTES = 6 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Rough but dependable HTML → readable text (keeps headings, lists, links). */
export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, '\n');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<a [^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      return text && /^https?:/.test(href) ? `[${text}](${href})` : text;
    })
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|header|main|form)>/gi, '\n\n')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export async function fetchPage(url, { signal } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal });
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`Page too large (${buf.length} bytes)`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (/pdf/.test(type)) return { url: res.url, title: url, text: `[PDF document, ${buf.length} bytes — download it with the shell tool to read it]`, status: res.status };
  if (/image\//.test(type)) return { url: res.url, title: url, text: `[Image ${type}, ${buf.length} bytes]`, status: res.status };
  const raw = buf.toString('utf8');
  if (/html/.test(type) || /^\s*</.test(raw)) {
    const title = decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url);
    const main = raw.match(/<main[\s\S]*?<\/main>/i)?.[0] || raw.match(/<article[\s\S]*?<\/article>/i)?.[0] || raw;
    return { url: res.url, title, text: htmlToText(main.length > 500 ? main : raw), status: res.status };
  }
  return { url: res.url, title: url, text: raw, status: res.status };
}

/** DuckDuckGo HTML results (no key needed). */
export async function searchDuckDuckGo(query, { max = 8, signal } = {}) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query, kl: 'us-en' }),
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  return { engine: 'DuckDuckGo', results: parseDuckDuckGo(await res.text(), max) };
}

export function parseDuckDuckGo(html, max = 8) {
  const results = [];
  const starts = [];
  const re = /<a[^>]*class="result__a"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length && results.length < max; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || block.match(/<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    results.push({ title: htmlToText(a[2]), url: href, snippet: snip ? htmlToText(snip[1]) : '' });
  }
  return results;
}



export async function searchBrave(query, key, { max = 8, signal } = {}) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return { engine: 'Brave', results: (data.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description || '') })) };
}

export async function webSearch(query, { max = 8, braveKey, signal } = {}) {
  if (braveKey) {
    try {
      return await searchBrave(query, braveKey, { max, signal });
    } catch { /* fall back */ }
  }
  return searchDuckDuckGo(query, { max, signal });
}
