import { ProviderError, toolResultText } from './common.js';
import { sanitizeId } from './openai-chat.js';

// Anthropic (Claude) adapter built on the official TypeScript SDK, loaded lazily
// as a vendored browser bundle. The browser talks to api.anthropic.com
// directly with the user's own key (dangerouslyAllowBrowser adds the
// anthropic-dangerous-direct-browser-access header the API requires for CORS).

let sdkPromise = null;
async function sdk() {
  sdkPromise ||= import('../../../vendor/anthropic-sdk.js');
  return (await sdkPromise).Anthropic;
}

async function client(provider) {
  const Anthropic = await sdk();
  return new Anthropic({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL || undefined,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    defaultHeaders: provider.headers || undefined,
  });
}

/** What each model family accepts. Unknown future models get the newest behavior. */
export function claudeTraits(model = '') {
  const m = model.toLowerCase();
  const is = (...prefixes) => prefixes.some((p) => m.startsWith(p));
  const legacy = is('claude-3', 'claude-2', 'claude-instant') || /claude-(opus|sonnet|haiku)-4-(0|1|5)\b/.test(m) || is('claude-opus-4-2', 'claude-sonnet-4-2', 'claude-haiku-4');
  const gen46 = is('claude-opus-4-6', 'claude-sonnet-4-6');
  const gen47 = is('claude-opus-4-7', 'claude-opus-4-8');
  const alwaysThinks = is('claude-fable', 'claude-mythos');
  const newest = !legacy && !gen46 && !gen47; // opus-5, sonnet-5, fable, mythos and later
  return {
    // How to request thinking: 'adaptive' | 'omit' | null (no thinking by default)
    thinking: legacy ? null : alwaysThinks ? 'omit' : 'adaptive',
    effort: !legacy,
    effortLevels: gen46 ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max'],
    // `display` is only needed (and only documented) from Opus 4.7 on; 4.6 summarizes by default.
    display: !legacy && !gen46,
    temperature: legacy || gen46,
    webTools: legacy
      ? { search: 'web_search_20250305', fetch: 'web_fetch_20250910' }
      : { search: 'web_search_20260209', fetch: 'web_fetch_20260209' },
    // Server-side refusal fallbacks ("default" routing) on the classifier-gated models.
    fallbacks: is('claude-opus-5', 'claude-fable-5-1'),
    newest,
  };
}

function b64(img) {
  return { type: 'base64', media_type: img.mime, data: img.data };
}

function userBlocks(parts) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image') out.push({ type: 'image', source: b64(p) });
    else if (p.type === 'document') {
      if (p.mime === 'application/pdf' && p.data) {
        out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data }, title: p.name });
      } else {
        out.push({ type: 'text', text: p.text ? `<file name="${p.name}">\n${p.text}\n</file>` : `[Attached file ${p.name} (${p.mime})]` });
      }
    }
  }
  return out.length ? out : [{ type: 'text', text: '(empty message)' }];
}

export function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', userBlocks(m.parts));
    else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.blocks) && m.raw.blocks.length) {
        push('assistant', m.raw.blocks);
        continue;
      }
      const blocks = [];
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
      if (text) blocks.push({ type: 'text', text });
      for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: sanitizeId(c.id), name: c.name, input: c.args ?? {} });
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: sanitizeId(r.id),
        is_error: !!r.isError,
        content: [
          { type: 'text', text: toolResultText(r) || '(no output)' },
          ...(r.images || []).map((img) => ({ type: 'image', source: b64(img) })),
        ],
      })));
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  return out;
}

function buildParams(req, { useFallbacks = true } = {}) {
  const t = claudeTraits(req.model);
  const betas = [];
  const params = {
    model: req.model,
    max_tokens: req.maxTokens || 32000,
    messages: toAnthropicMessages(req.messages),
    cache_control: { type: 'ephemeral' },
  };
  if (req.system) params.system = req.system;
  const tools = (req.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    eager_input_streaming: true,
  }));
  if (req.serverTools?.includes('web_search')) tools.push({ type: t.webTools.search, name: 'web_search', max_uses: 8 });
  if (req.serverTools?.includes('web_fetch')) tools.push({ type: t.webTools.fetch, name: 'web_fetch', max_uses: 8 });
  if (tools.length) params.tools = tools;

  if (req.thinking !== false && t.thinking) {
    params.thinking = t.display ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
  } else if (req.thinking === false && t.thinking === 'adaptive' && !t.newest) {
    params.thinking = { type: 'disabled' };
  }
  if (t.effort && req.reasoningEffort && t.effortLevels.includes(req.reasoningEffort)) {
    params.output_config = { effort: req.reasoningEffort };
  }
  if (t.temperature && req.temperature != null) params.temperature = req.temperature;
  if (t.fallbacks && useFallbacks && !req.noFallbacks) {
    params.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }
  return { params, betas };
}

function searchSources(block) {
  if (!Array.isArray(block?.content)) return [];
  return block.content
    .filter((r) => r && r.url)
    .map((r) => ({ url: r.url, title: r.title || r.url }));
}

/** Streamed Messages API call with tools. Returns the neutral result shape. */
export async function anthropicMessage(req) {
  const { provider, signal, onEvent = () => {} } = req;
  const c = await client(provider);
  let attempt = 0;
  let useFallbacks = true;
  let jsonRetries = 0;
  for (;;) {
    const { params, betas } = buildParams(req, { useFallbacks });
    const stream = betas.length
      ? c.beta.messages.stream({ ...params, betas }, { signal })
      : c.messages.stream(params, { signal });
    const blockKinds = new Map();
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          blockKinds.set(ev.index, b);
          if (b.type === 'tool_use') onEvent({ type: 'tool_start', id: b.id, name: b.name });
          else if (b.type === 'server_tool_use') onEvent({ type: 'server_tool', id: b.id, name: b.name, status: 'start', input: b.input });
          else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') {
            const sources = b.type === 'web_search_tool_result' ? searchSources(b) : (b.content?.url ? [{ url: b.content.url, title: b.content?.content?.title || b.content.url }] : []);
            onEvent({ type: 'server_tool', id: b.tool_use_id, status: 'done', sources, error: Array.isArray(b.content) ? null : b.content?.error_code });
          } else if (b.type === 'fallback') {
            onEvent({ type: 'notice', text: `${b.from?.model || 'The model'} declined; continuing with ${b.to?.model || 'a fallback model'}.` });
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta;
          const b = blockKinds.get(ev.index);
          if (d.type === 'text_delta') onEvent({ type: 'text', text: d.text });
          else if (d.type === 'thinking_delta') onEvent({ type: 'thinking', text: d.thinking });
          else if (d.type === 'input_json_delta' && b?.type === 'tool_use') onEvent({ type: 'tool_args', id: b.id, delta: d.partial_json });
          else if (d.type === 'input_json_delta' && b?.type === 'server_tool_use') onEvent({ type: 'server_tool_args', id: b.id, delta: d.partial_json });
          else if (d.type === 'citations_delta' && d.citation?.url) onEvent({ type: 'citation', url: d.citation.url, title: d.citation.title || '' });
        }
      }
      const msg = await stream.finalMessage();
      return normalize(msg, req.model);
    } catch (err) {
      if (signal?.aborted) throw err;
      const Anthropic = await sdk();
      if (err instanceof Anthropic.APIError) {
        const text = String(err.message || '');
        if (err.status === 400 && useFallbacks && /fallback/i.test(text)) {
          useFallbacks = false;
          continue;
        }
        if (err.status === 400 && /signature|thinking/i.test(text) && attempt === 0 && req.messages.some((m) => m.raw)) {
          // History no longer matches the thinking blocks' signatures: replay without them once.
          attempt++;
          req = { ...req, messages: req.messages.map(stripThinking) };
          continue;
        }
        throw new ProviderError(`Anthropic error ${err.status ?? ''}: ${friendly(err)}`, { status: err.status, provider: provider.label });
      }
      // Non-API error while finalizing: usually an unparseable streamed tool input. Re-issue the turn.
      if (jsonRetries++ < 2 && /json/i.test(String(err?.message))) continue;
      throw err;
    }
  }
}

function stripThinking(m) {
  if (m.role !== 'assistant' || !m.raw?.blocks) return m;
  return { ...m, raw: { ...m.raw, blocks: m.raw.blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } };
}

function friendly(err) {
  const msg = err?.error?.error?.message || err?.message || 'request failed';
  if (err.status === 401) return `${msg} (check your Anthropic API key)`;
  if (err.status === 429) return `${msg} (rate limited — try again shortly)`;
  if (err.status === 529) return `${msg} (Anthropic is overloaded — try again shortly)`;
  return msg;
}

function normalize(msg, requestedModel) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  const citations = new Map();
  for (const b of msg.content || []) {
    if (b.type === 'text') {
      text += b.text;
      for (const c of b.citations || []) if (c.url && !citations.has(c.url)) citations.set(c.url, { url: c.url, title: c.title || '' });
    } else if (b.type === 'thinking') thinking += b.thinking || '';
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  const stop = msg.stop_reason;
  return {
    text,
    thinking,
    toolCalls,
    stopReason: stop === 'tool_use' ? 'tool_use'
      : stop === 'max_tokens' ? 'max_tokens'
        : stop === 'refusal' ? 'refusal'
          : stop === 'pause_turn' ? 'pause'
            : 'end',
    refusal: stop === 'refusal' ? (msg.stop_details || {}) : null,
    raw: { provider: 'anthropic', model: msg.model || requestedModel, blocks: msg.content },
    usage: msg.usage ? {
      input: msg.usage.input_tokens ?? 0,
      output: msg.usage.output_tokens ?? 0,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
    } : null,
    citations: [...citations.values()],
    model: msg.model || requestedModel,
  };
}

export async function listAnthropicModels(provider) {
  const c = await client(provider);
  const out = [];
  for await (const m of c.models.list({ limit: 100 })) {
    out.push({ id: m.id, name: m.display_name, contextLength: m.max_input_tokens, maxOutput: m.max_tokens, created: m.created_at });
  }
  return out;
}
