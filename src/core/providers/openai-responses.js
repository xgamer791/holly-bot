import { readSSE } from './sse.js';
import { safeJsonParse } from '../util.js';
import { ProviderError, toolResultText } from './common.js';
import { sanitizeId } from './openai-chat.js';

// Responses API adapter (OpenAI and xAI). Used because server-side tools —
// web search, and on xAI also X search — are exposed through this API.

function inputFromMessages(messages, { replayReasoning }) {
  const input = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'input_text', text: p.text });
        else if (p.type === 'image') content.push({ type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` });
        else if (p.type === 'document') content.push({ type: 'input_text', text: p.text ? `<file name="${p.name}">\n${p.text}\n</file>` : `[Attached file ${p.name} (${p.mime})]` });
      }
      input.push({ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '(empty message)' }] });
    } else if (m.role === 'assistant') {
      if (m.raw?.provider === 'responses' && Array.isArray(m.raw.items)) {
        for (const item of m.raw.items) {
          if (item.type === 'reasoning' && !replayReasoning) continue;
          input.push(stripOutputOnly(item));
        }
        continue;
      }
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const c of m.toolCalls || []) {
        input.push({ type: 'function_call', call_id: sanitizeId(c.id), name: c.name, arguments: JSON.stringify(c.args ?? {}) });
      }
    } else if (m.role === 'tool') {
      const images = [];
      for (const r of m.results) {
        input.push({ type: 'function_call_output', call_id: sanitizeId(r.id), output: toolResultText(r) || '(no output)' });
        images.push(...(r.images || []));
      }
      if (images.length) {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: '[Image output from the tool call above]' }, ...images.map((img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.data}` }))],
        });
      }
    }
  }
  return input;
}

/** Output items can't always be echoed verbatim (status fields etc.). */
function stripOutputOnly(item) {
  const { status, ...rest } = item;
  if (rest.type === 'message') {
    return { role: 'assistant', content: (rest.content || []).filter((c) => c.type === 'output_text').map((c) => ({ type: 'output_text', text: c.text })) };
  }
  return rest;
}

export async function responsesCall(req) {
  const { provider, model, signal, onEvent = () => {} } = req;
  const isXai = provider.id === 'xai';
  const reasoningModel = /^(o\d|gpt-5)/.test(model);
  const body = {
    model,
    input: inputFromMessages(req.messages, { replayReasoning: !isXai && reasoningModel }),
    stream: true,
    store: false,
  };
  if (req.system) body.instructions = req.system;
  const tools = (req.tools || []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  for (const st of req.serverTools || []) {
    if (st === 'web_search') tools.push({ type: 'web_search' });
    if (st === 'x_search' && isXai) tools.push({ type: 'x_search' });
  }
  if (tools.length) body.tools = tools;
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (!isXai && reasoningModel) {
    body.reasoning = { summary: 'auto', ...(req.reasoningEffort && ['minimal', 'low', 'medium', 'high'].includes(req.reasoningEffort) ? { effort: req.reasoningEffort } : {}) };
    body.include = ['reasoning.encrypted_content'];
  }
  if (req.temperature != null && !reasoningModel) body.temperature = req.temperature;
  if (req.json) body.text = { format: { type: 'json_object' } };

  const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, ...(provider.headers || {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await ProviderError.fromResponse(res, provider.label);
    // Some tool types are not available for every model/account: retry once without server tools.
    if (res.status === 400 && (req.serverTools || []).length && /tool|search/i.test(err.message)) {
      return responsesCall({ ...req, serverTools: [] });
    }
    throw err;
  }

  let text = '';
  let thinking = '';
  let usage = null;
  let finalResponse = null;
  let servedModel = model;
  const calls = new Map();
  const citations = new Map();
  const serverCalls = new Map();

  for await (const evt of readSSE(res.body, signal)) {
    if (evt.data === '[DONE]') break;
    const d = safeJsonParse(evt.data);
    if (!d) continue;
    const type = d.type || evt.event;
    switch (type) {
      case 'response.output_text.delta':
        text += d.delta || '';
        onEvent({ type: 'text', text: d.delta || '' });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        thinking += d.delta || '';
        onEvent({ type: 'thinking', text: d.delta || '' });
        break;
      case 'response.reasoning_summary_part.done':
        thinking += '\n\n';
        break;
      case 'response.output_text.annotation.added': {
        const a = d.annotation || {};
        if (a.url && !citations.has(a.url)) {
          citations.set(a.url, { url: a.url, title: a.title || '' });
          onEvent({ type: 'citation', url: a.url, title: a.title || '' });
        }
        break;
      }
      case 'response.output_item.added': {
        const item = d.item || {};
        if (item.type === 'function_call') {
          calls.set(item.id, { id: item.call_id || item.id, name: item.name || '', argsText: '' });
          onEvent({ type: 'tool_start', id: item.call_id || item.id, name: item.name || '' });
        } else if (item.type && item.type.endsWith('_call')) {
          const name = item.type.replace(/_call$/, '');
          serverCalls.set(item.id, name);
          onEvent({ type: 'server_tool', id: item.id, name, status: 'start', input: item.action || {} });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const c = calls.get(d.item_id);
        if (c) {
          c.argsText += d.delta || '';
          onEvent({ type: 'tool_args', id: c.id, delta: d.delta || '' });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = d.item || {};
        if (item.type === 'function_call') {
          const c = calls.get(item.id) || { id: item.call_id, name: item.name, argsText: '' };
          c.argsText = item.arguments ?? c.argsText;
          c.name = item.name || c.name;
          c.id = item.call_id || c.id;
          calls.set(item.id, c);
        } else if (serverCalls.has(item.id)) {
          const sources = (item.action?.sources || item.results || []).filter((s) => s?.url).map((s) => ({ url: s.url, title: s.title || s.url }));
          onEvent({ type: 'server_tool', id: item.id, status: 'done', input: item.action || {}, sources });
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        finalResponse = d.response;
        break;
      case 'response.failed':
      case 'error': {
        const e = d.response?.error || d.error || d;
        throw new ProviderError(`${provider.label}: ${e.message || JSON.stringify(e)}`, { provider: provider.label, code: e.code });
      }
      default:
        if (d.response?.model) servedModel = d.response.model;
        break;
    }
  }

  const output = finalResponse?.output || [];
  if (finalResponse?.model) servedModel = finalResponse.model;
  if (finalResponse?.usage) {
    const u = finalResponse.usage;
    usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
    };
  }
  // Prefer the final output for text (some servers skip deltas for short replies).
  if (!text) {
    for (const item of output) {
      if (item.type === 'message') for (const c of item.content || []) if (c.type === 'output_text') text += c.text;
    }
  }
  for (const item of output) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        for (const a of c.annotations || []) {
          if (a.url && !citations.has(a.url)) citations.set(a.url, { url: a.url, title: a.title || '' });
        }
      }
    }
  }
  for (const c of finalResponse?.citations || []) {
    const url = typeof c === 'string' ? c : c?.url;
    if (url && !citations.has(url)) citations.set(url, { url, title: c?.title || '' });
  }

  const fromOutput = output.filter((i) => i.type === 'function_call').map((i) => ({ id: i.call_id || i.id, name: i.name, argsText: i.arguments || '' }));
  const callList = fromOutput.length ? fromOutput : [...calls.values()];
  const toolCalls = callList.filter((c) => c.name).map((c) => {
    const args = c.argsText?.trim() ? safeJsonParse(c.argsText, undefined) : {};
    return { id: sanitizeId(c.id), name: c.name, args: args ?? {}, argsError: args === undefined ? c.argsText : undefined };
  });
  const incomplete = finalResponse?.status === 'incomplete' || finalResponse?.incomplete_details;
  return {
    text,
    thinking,
    toolCalls,
    stopReason: toolCalls.length ? 'tool_use' : incomplete && /max_output/.test(finalResponse?.incomplete_details?.reason || '') ? 'max_tokens'
      : /content_filter/.test(finalResponse?.incomplete_details?.reason || '') ? 'refusal' : 'end',
    raw: output.length ? { provider: 'responses', items: output } : null,
    usage,
    citations: [...citations.values()],
    model: servedModel,
  };
}
