import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSSE, parseEvent } from '../../src/core/providers/sse.js';
import { chatCompletion, toChatMessages } from '../../src/core/providers/openai-chat.js';

function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test('parseEvent handles fields and comments', () => {
  assert.deepEqual(parseEvent('event: ping\ndata: {"a":1}'), { event: 'ping', data: '{"a":1}' });
  assert.equal(parseEvent(': keep-alive'), null);
  assert.deepEqual(parseEvent('data: line1\ndata: line2'), { event: 'message', data: 'line1\nline2' });
});

test('readSSE splits across chunk boundaries and CRLF', async () => {
  const out = [];
  for await (const e of readSSE(streamOf(['data: {"x"', ':1}\r\n\r\nda', 'ta: [DONE]\n\n', 'data: tail']))) out.push(e.data);
  assert.deepEqual(out, ['{"x":1}', '[DONE]', 'tail']);
});

test('chatCompletion assembles text, reasoning, tool calls, citations and usage', async (t) => {
  const sse = [
    { choices: [{ delta: { role: 'assistant', reasoning_content: 'Thinking…' } }] },
    { choices: [{ delta: { content: 'Hello ' } }] },
    { choices: [{ delta: { content: 'world' } }], citations: ['https://example.com/a'] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'recall', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"dogs"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ].map((c) => `data: ${JSON.stringify(c)}\n\n`).concat(['data: [DONE]\n\n']);
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    captured = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(streamOf(sse), { status: 200 });
  });
  const events = [];
  const res = await chatCompletion({
    provider: { baseURL: 'https://api.example.com/v1/', apiKey: 'k', label: 'Test' },
    model: 'm1',
    system: 'sys',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'recall', description: 'd', parameters: { type: 'object', properties: {} } }],
    onEvent: (e) => events.push(e),
  });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer k');
  assert.equal(captured.body.messages[0].role, 'system');
  assert.equal(res.text, 'Hello world');
  assert.equal(res.thinking, 'Thinking…');
  assert.deepEqual(res.toolCalls, [{ id: 'call_1', name: 'recall', args: { query: 'dogs' }, argsError: undefined }]);
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.usage, { input: 12, output: 7, cacheRead: 0, reasoning: 0 });
  assert.deepEqual(res.citations, [{ url: 'https://example.com/a', title: '' }]);
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'recall'));
});

test('toChatMessages renders tool steps and images', () => {
  const msgs = toChatMessages({
    system: 's',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAA' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'checking' }], toolCalls: [{ id: 'c1', name: 'run_python', args: { code: '1+1' } }] },
      { role: 'tool', results: [{ id: 'c1', name: 'run_python', content: '2', images: [{ mime: 'image/png', data: 'BBB' }] }] },
    ],
  });
  assert.equal(msgs[1].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"code":"1+1"}');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[4].role, 'user');
});

test('DeepSeek thinking mode: reasoning_content is replayed verbatim (or empty) on every assistant turn', () => {
  const msgs = toChatMessages({
    replayReasoning: true,
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }], reasoning: null },
      { role: 'user', parts: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', parts: [], toolCalls: [{ id: 'c1', name: 'shell', args: { command: 'ls' } }], reasoning: 'I will list files.' },
      { role: 'tool', results: [{ id: 'c1', name: 'shell', content: 'a.txt' }] },
    ],
  });
  assert.equal(msgs[1].reasoning_content, '');
  assert.equal(msgs[3].reasoning_content, 'I will list files.');
  const plain = toChatMessages({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'x' }], reasoning: 'r' }] });
  assert.equal('reasoning_content' in plain[0], false);
});
