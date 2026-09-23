import { readSSE } from './sse.js';
import { safeJsonParse } from '../util.js';
import { ProviderError, toolResultText } from './common.js';

// OpenAI-compatible Chat Completions adapter. Used for xAI (fallback path),
// Google Gemini (OpenAI endpoint), OpenRouter, Groq, DeepSeek, Mistral,
// Together, Ollama / LM Studio and any custom compatible server.

export function toChatMessages(req) {
  const out = [];
  if (req.system) out.push({ role: req.systemRole || 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.parts, req) });
    } else if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
      const msg = { role: 'assistant', content: text || (m.toolCalls?.length ? null : '') };
      // DeepSeek thinking mode (with tools) rejects history whose assistant turns lack their reasoning.
      if (req.replayReasoning) msg.reasoning_content = typeof m.reasoning === 'string' ? m.reasoning : '';
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const images = [];
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: toolResultText(r) });
        for (const img of r.images || []) images.push(img);
      }
      // Tool messages are text-only on most compatible servers; pass images as a user turn.
      if (images.length && req.vision !== false) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: '[Image output from the tool call above]' },
            ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
          ],
        });
      }
    }
  }
  return out;
}

function userContent(parts, req) {
  const hasMedia = parts.some((p) => p.type === 'image');
  if (!hasMedia || req.vision === false) {
    return parts.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image omitted: model has no vision]' : docText(p)))
      .filter(Boolean).join('\n\n');
  }
  return parts.map((p) => {
    if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } };
    if (p.type === 'text') return { type: 'text', text: p.text };
    return { type: 'text', text: docText(p) };
  });
}

function docText(p) {
  if (p.type === 'document') return p.text ? `<file name="${p.name}">\n${p.text}\n</file>` : `[Attached file ${p.name} (${p.mime}) — binary content not readable by this model]`;
  return '';
}

export function toChatTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Stream a chat completion.
 * @returns {Promise<{text, thinking, toolCalls, stopReason, usage, citations, model}>}
 */
export async function chatCompletion(req) {
  const { provider, model, signal, onEvent = () => {} } = req;
  const body = {
    model,
    messages: toChatMessages(req),
    stream: true,
  };
  if (provider.streamUsage !== false) body.stream_options = { include_usage: true };
  if (req.tools?.length) {
    body.tools = toChatTools(req.tools);
    body.tool_choice = 'auto';
  }
  if (req.maxTokens) body[provider.maxTokensField || 'max_tokens'] = req.maxTokens;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
  if (req.json) body.response_format = { type: 'json_object' };
  if (req.extraBody) Object.assign(body, req.extraBody);

  const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await ProviderError.fromResponse(res, provider.label);

  let text = '';
  let thinking = '';
  let reasoningRaw = '';
  let finish = null;
  let usage = null;
  let servedModel = model;
  const calls = [];
  const citations = new Map();
  const byIndex = new Map();

  for await (const evt of readSSE(res.body, signal)) {
    if (evt.data === '[DONE]') break;
    const chunk = safeJsonParse(evt.data);
    if (!chunk) continue;
    if (chunk.error) throw new ProviderError(chunk.error.message || JSON.stringify(chunk.error), { status: chunk.error.code, provider: provider.label });
    if (chunk.model) servedModel = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const url of chunk.citations || []) addCitation(citations, onEvent, typeof url === 'string' ? { url } : url);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || choice.message || {};
    const reasoning = d.reasoning_content ?? d.reasoning ?? (Array.isArray(d.reasoning_details) ? d.reasoning_details.map((r) => r.text || r.summary || '').join('') : null);
    if (typeof d.reasoning_content === 'string') reasoningRaw += d.reasoning_content;
    if (typeof reasoning === 'string' && reasoning) {
      thinking += reasoning;
      onEvent({ type: 'thinking', text: reasoning });
    }
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      onEvent({ type: 'text', text: d.content });
    }
    for (const ann of d.annotations || []) {
      const c = ann.url_citation || ann;
      if (c?.url) addCitation(citations, onEvent, { url: c.url, title: c.title });
    }
    for (const tc of d.tool_calls || []) {
      const key = tc.index ?? (tc.id ? `id:${tc.id}` : calls.length - 1);
      let call = byIndex.get(key);
      if (!call || (tc.id && call.id && tc.id !== call.id && tc.index == null)) {
        call = { id: tc.id || `call_${calls.length}_${Date.now().toString(36)}`, name: '', argsText: '' };
        byIndex.set(key, call);
        calls.push(call);
      }
      if (tc.id && !call.id) call.id = tc.id;
      if (tc.function?.name) {
        const first = !call.name;
        call.name += tc.function.name;
        if (first) onEvent({ type: 'tool_start', id: call.id, name: call.name });
      }
      if (tc.function?.arguments) {
        const a = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        call.argsText += a;
        onEvent({ type: 'tool_args', id: call.id, delta: a });
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const toolCalls = calls.filter((c) => c.name).map((c) => {
    const args = c.argsText.trim() ? safeJsonParse(c.argsText, undefined) : {};
    return { id: sanitizeId(c.id), name: c.name, args: args ?? {}, argsError: args === undefined ? c.argsText : undefined };
  });

  return {
    text,
    thinking,
    toolCalls,
    stopReason: mapFinish(finish, toolCalls.length),
    usage: usage ? {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      cacheRead: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    } : null,
    citations: [...citations.values()],
    model: servedModel,
    // Verbatim reasoning, replayed on later requests for providers that require it (DeepSeek).
    raw: reasoningRaw ? { provider: 'openai-chat', reasoning_content: reasoningRaw } : null,
  };
}

function addCitation(map, onEvent, c) {
  if (!c?.url || map.has(c.url)) return;
  map.set(c.url, { url: c.url, title: c.title || '' });
  onEvent({ type: 'citation', url: c.url, title: c.title || '' });
}

function mapFinish(reason, nCalls) {
  if (nCalls) return 'tool_use';
  switch (reason) {
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    case 'tool_calls':
    case 'function_call': return nCalls ? 'tool_use' : 'end';
    default: return 'end';
  }
}

export function sanitizeId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return clean || `call_${Math.random().toString(36).slice(2, 10)}`;
}

/** GET /models → [{ id, name?, contextLength? }] */
export async function listChatModels(provider, signal) {
  const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/models`, {
    headers: {
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers || {}),
    },
    signal,
  });
  if (!res.ok) throw await ProviderError.fromResponse(res, provider.label);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data.data || data.models || [];
  return rows.map((m) => ({
    id: String(m.id || m.name || '').replace(/^models\//, ''),
    name: m.name && m.name !== m.id ? m.name : undefined,
    contextLength: m.context_length || m.context_window || m.inputTokenLimit,
    created: m.created,
    input: m.architecture?.input_modalities || m.input_modalities,
    output: m.architecture?.output_modalities || m.output_modalities,
  })).filter((m) => m.id);
}

/** POST /embeddings */
export async function chatEmbeddings(provider, model, texts, signal) {
  const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers || {}),
    },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!res.ok) throw await ProviderError.fromResponse(res, provider.label);
  const data = await res.json();
  return (data.data || []).sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}
