// Scripted fake of the xAI Responses API for browser end-to-end tests.
// Routes are installed with Playwright's page.route, so the app's real
// provider adapter (fetch + SSE parsing) runs against it.

export function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

export function textResponse(text, { model = 'grok-4', citations = [] } = {}) {
  const chunks = text.match(/.{1,12}/gs) || [''];
  const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text, annotations: citations.map((c) => ({ type: 'url_citation', url: c.url, title: c.title })) }] };
  return sse([
    { type: 'response.created', response: { id: 'resp_1', model, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    ...chunks.map((delta) => ({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta })),
    ...citations.map((c) => ({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: c.url, title: c.title } })),
    { type: 'response.completed', response: { id: 'resp_1', model, status: 'completed', output: [item], usage: { input_tokens: 1200, output_tokens: 60, input_tokens_details: { cached_tokens: 800 } } } },
  ]);
}

export function toolResponse(calls, { text = '', model = 'grok-4' } = {}) {
  const items = [];
  const events = [{ type: 'response.created', response: { id: 'resp_2', model, status: 'in_progress' } }];
  if (text) {
    items.push({ type: 'message', id: 'msg_0', role: 'assistant', content: [{ type: 'output_text', text }] });
    events.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_0', role: 'assistant', content: [] } });
    events.push({ type: 'response.output_text.delta', item_id: 'msg_0', output_index: 0, content_index: 0, delta: text });
  }
  calls.forEach((c, i) => {
    const item = { type: 'function_call', id: `fc_${i}`, call_id: c.id || `call_${i}_${Date.now()}`, name: c.name, arguments: JSON.stringify(c.args) };
    items.push(item);
    events.push({ type: 'response.output_item.added', output_index: items.length - 1, item: { ...item, arguments: '' } });
    events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: items.length - 1, delta: item.arguments });
    events.push({ type: 'response.output_item.done', output_index: items.length - 1, item });
  });
  events.push({ type: 'response.completed', response: { id: 'resp_2', model, status: 'completed', output: items, usage: { input_tokens: 1300, output_tokens: 40 } } });
  return sse(events);
}

export function webSearchResponse(query, text, sources) {
  const events = [
    { type: 'response.created', response: { id: 'resp_3', model: 'grok-4', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress', action: { type: 'search', query } } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query, sources } } },
  ];
  const body = textResponse(text, { citations: sources }).split('\n\n').filter(Boolean).slice(1).join('\n\n');
  return `${sse(events)}${body}\n\n`;
}

/** Helpers to inspect a Responses API request body. */
export function describeRequest(body) {
  const input = body.input || [];
  const last = input[input.length - 1] || {};
  const lastUserText = last.role === 'user'
    ? (last.content || []).filter((c) => c.type === 'input_text').map((c) => c.text).filter((t) => !t.startsWith('<context>')).join('\n')
    : '';
  const lastTool = last.type === 'function_call_output' ? last : null;
  const toolCallFor = (callId) => input.find((i) => i.type === 'function_call' && i.call_id === callId);
  const me = /You are ([^,]+), one of/.exec(body.instructions || '')?.[1] || '';
  return {
    input, last, lastUserText, lastTool, lastToolName: lastTool ? toolCallFor(lastTool.call_id)?.name : null,
    me, instructions: body.instructions || '', tools: (body.tools || []).map((t) => t.name || t.type),
    isMemoryJob: /long-term memory of|compress conversation|route messages|reflect on what it knows|"human" core-memory/.test(body.instructions || ''),
  };
}

/**
 * Install xAI mocks on a Playwright page.
 * `script(req)` receives describeRequest(...) output and returns an SSE string.
 */
export async function mockXai(page, script, log = []) {
  await page.route('https://api.x.ai/v1/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ data: [{ id: 'grok-4' }, { id: 'grok-4-fast-reasoning' }, { id: 'grok-4-fast-non-reasoning' }, { id: 'grok-code-fast-1' }, { id: 'grok-2-image-1212' }] }),
  }));
  await page.route('https://api.x.ai/v1/responses', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    }
    const body = JSON.parse(req.postData() || '{}');
    const d = describeRequest(body);
    log.push(d);
    const payload = await script(d, body);
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: payload });
  });
}
