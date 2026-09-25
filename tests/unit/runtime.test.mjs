import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../src/core/app.js';
import { finalText } from '../../src/core/runtime.js';

let n = 0;

/**
 * Scripted fake provider: `script(req, ctx)` returns a partial result.
 * ctx.lastUserText is the text of the last user message (with context stripped).
 */
async function makeApp(script) {
  const app = await App.create({ dbName: `rt-${process.pid}-${n++}` });
  // Bots run on Holly Bot's AI: DeepSeek, here on a saved key (src/core/providers).
  await app.saveSettings({ providers: { deepseek: { apiKey: 'sk-test' } }, defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same' }, memory: { auto: true, embeddings: 'off', contextBudget: 24000 } });
  const calls = [];
  app.providers.chat = async (req) => {
    const last = [...req.messages].reverse().find((m) => m.role === 'user' || m.role === 'tool');
    const lastUserText = last?.role === 'user' ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).filter((t) => !t.startsWith('<context>') && !t.startsWith('[Note to you')).join('\n') : '';
    const lastTool = last?.role === 'tool' ? last.results : null;
    const ctx = { lastUserText, lastTool, system: req.system, isMemoryJob: /long-term memory of|compress conversation|route messages/.test(req.system || '') };
    calls.push({ req, ctx });
    const out = await script(req, ctx);
    const res = { text: '', thinking: '', toolCalls: [], stopReason: 'end', usage: { input: 10, output: 5 }, citations: [], model: 'gpt-test', ...out };
    if (res.toolCalls.length) res.stopReason = 'tool_use';
    for (const ch of res.text.match(/.{1,8}/gs) || []) req.onEvent?.({ type: 'text', text: ch });
    return res;
  };
  return { app, calls };
}

const settle = (app) => new Promise((r) => setTimeout(r, 30)).then(() => Promise.all([...app.runtime.bgQueues.values()]));

test('onboarding card, memory tool, and automatic memory extraction', async () => {
  const { app } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) {
      return { text: JSON.stringify({ operations: [{ op: 'add', text: 'User wants help with coding projects.', type: 'goal', importance: 6 }] }) };
    }
    if (ctx.lastUserText === 'Coding & projects') return { text: 'Great — what are you building?' };
    if (/dog/.test(ctx.lastUserText)) return { toolCalls: [{ id: 'c1', name: 'remember', args: { text: 'User has a dog named Max.', type: 'fact', importance: 7 } }] };
    if (ctx.lastTool?.[0]?.name === 'remember') return { text: 'Got it, I will remember Max.' };
    return { text: 'ok' };
  });
  const holly = await app.createAgent({ name: 'Holly', shape: 'cloud', color: 'white' });
  const thread = app.getThread(`dm_${holly.id}`);
  let msgs = await app.loadMessages(thread.id);
  assert.equal(msgs.length, 1);
  const greet = msgs[0];
  assert.match(finalText(greet), /I'm Holly/);
  const card = greet.steps[0].toolCalls[0];
  assert.equal(card.pending.options.length, 5);

  await app.runtime.answer(greet.id, card.id, 'Coding & projects');
  msgs = await app.loadMessages(thread.id);
  assert.equal(msgs.at(-1).authorType, 'agent');
  assert.equal(finalText(msgs.at(-1)), 'Great — what are you building?');
  assert.equal(app.getAgent(holly.id).focus, 'Coding & projects');

  await app.runtime.send(thread.id, { text: 'My dog is called Max' });
  msgs = await app.loadMessages(thread.id);
  const reply = msgs.at(-1);
  assert.equal(finalText(reply), 'Got it, I will remember Max.');
  assert.equal(reply.steps[0].toolCalls[0].status, 'done');
  await settle(app);
  const mems = await app.memory.list(holly.id);
  assert.ok(mems.some((m) => /Max/.test(m.text)), 'remember tool saved memory');
  assert.ok(mems.some((m) => /coding projects/.test(m.text)), 'auto extraction saved memory');
  assert.equal(app.getThread(thread.id).status, 'idle');
});

test('bots talk to each other with message_agent and keep separate memories', async () => {
  const { app } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    const me = /You are (\w+)/.exec(req.system)?.[1];
    if (me === 'Holly' && /ask nova/i.test(ctx.lastUserText)) {
      return { toolCalls: [{ id: 'm1', name: 'message_agent', args: { agent: 'Nova', message: 'What is 2+2?' } }] };
    }
    if (me === 'Holly' && ctx.lastTool) return { text: `Nova says: ${ctx.lastTool[0].content.split('\n').pop()}` };
    if (me === 'Nova') {
      assert.match(ctx.lastUserText, /\[Holly\]: What is 2\+2\?/);
      assert.match(req.system, /Private channel with Holly/);
      return { text: 'It is 4.' };
    }
    return { text: 'hmm' };
  });
  const holly = await app.createAgent({ name: 'Holly', greet: false });
  const nova = await app.createAgent({ name: 'Nova', description: 'Math whiz', greet: false });
  await app.runtime.send(`dm_${holly.id}`, { text: 'Ask Nova what 2+2 is' });
  const msgs = await app.loadMessages(`dm_${holly.id}`);
  const last = msgs.at(-1);
  assert.equal(finalText(last), 'Nova says: It is 4.');
  const call = last.steps[0].toolCalls[0];
  assert.equal(call.display.kind, 'agent_chat');
  assert.equal(call.display.reply, 'It is 4.');
  const channel = app.getThread([holly.id, nova.id].sort().reduce((a, b) => `ag_${a}_${b}`));
  assert.ok(channel, 'agent channel exists');
  const chMsgs = await app.loadMessages(channel.id);
  assert.equal(chMsgs.length, 2);
  assert.equal(chMsgs[0].authorId, holly.id);
  assert.equal(chMsgs[1].authorId, nova.id);

  await app.memory.add(holly.id, { text: 'Holly private fact about pineapples' });
  const novaSees = await app.memory.search(nova.id, 'pineapples', { includeShared: true });
  assert.equal(novaSees.length, 0);
});

test('Auto-review pauses risky tools until approved, then resumes', async () => {
  const { app } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    if (/make a bot/i.test(ctx.lastUserText)) return { toolCalls: [{ id: 'k1', name: 'create_agent', args: { name: 'Scout', description: 'Researcher' } }] };
    if (ctx.lastTool?.[0]?.name === 'create_agent') return { text: ctx.lastTool[0].isError ? 'Okay, I will not.' : 'Scout is ready.' };
    return { text: 'ok' };
  });
  await app.saveSettings({ askFirst: true }); // Auto-review is off unless turned on
  const holly = await app.createAgent({ name: 'Holly', greet: false });
  const tid = `dm_${holly.id}`;
  const res = await app.runtime.send(tid, { text: 'Please make a bot for research' });
  assert.equal(res.status, 'waiting');
  assert.equal(app.getThread(tid).status, 'waiting');
  assert.match(app.getThread(tid).preview.text, /^Permission required: Create a new bot named “Scout”/);
  assert.equal(app.findAgent('Scout'), null);
  const waiting = await app.runtime.findWaiting(tid);
  await app.runtime.approve(waiting.message.id, waiting.call.id, 'approve');
  assert.ok(app.findAgent('Scout'), 'bot created after approval');
  const msgs = await app.loadMessages(tid);
  assert.equal(finalText(msgs.at(-1)), 'Scout is ready.');
  assert.equal(app.getThread(tid).status, 'idle');
});

test('ask_user pauses the turn; typing in chat answers it', async () => {
  const { app, calls } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    if (/plan my trip/i.test(ctx.lastUserText)) {
      return { text: 'Quick question.', toolCalls: [{ id: 'q1', name: 'ask_user', args: { question: 'Beach or mountains?', options: ['Beach', 'Mountains'] } }] };
    }
    if (ctx.lastTool?.[0]?.name === 'ask_user') return { text: `Planning a ${ctx.lastTool[0].content.includes('Mountains') ? 'mountain' : 'beach'} trip.` };
    return { text: 'ok' };
  });
  const holly = await app.createAgent({ name: 'Holly', greet: false });
  const tid = `dm_${holly.id}`;
  const r = await app.runtime.send(tid, { text: 'Plan my trip' });
  assert.equal(r.status, 'waiting');
  assert.match(app.getThread(tid).preview.text, /Waiting for you: Beach or mountains\?/);
  await app.runtime.send(tid, { text: 'Mountains please' });
  const msgs = await app.loadMessages(tid);
  assert.equal(finalText(msgs.at(-1)), 'Planning a mountain trip.');
  const answerBubble = msgs.find((m) => m.answerTo);
  assert.ok(answerBubble, 'typed answer shown as a bubble');
  // The typed answer is delivered as the tool result, not duplicated as a user turn.
  const lastReq = calls.filter((c) => !c.ctx.isMemoryJob).at(-1).req;
  const userTexts = lastReq.messages.filter((m) => m.role === 'user').flatMap((m) => m.parts.map((p) => p.text || ''));
  assert.ok(!userTexts.some((t) => t === 'Mountains please'));
});

test('group chat routes to picked speakers and hides [PASS]', async () => {
  const { app } = await makeApp(async (req, ctx) => {
    if (/route messages in a group chat/.test(req.system)) return { text: '{"speakers":["Ada","Bo"]}' };
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    const me = /You are (\w+)/.exec(req.system)?.[1];
    if (me === 'Ada') return { text: 'Ada here: use Postgres. @Cy what do you think?' };
    if (me === 'Bo') return { text: '[PASS]' };
    if (me === 'Cy') {
      assert.match(ctx.lastUserText, /\[Ada\]: Ada here/);
      return { text: 'Cy agrees.' };
    }
    return { text: '?' };
  });
  const ada = await app.createAgent({ name: 'Ada', greet: false });
  const bo = await app.createAgent({ name: 'Bo', greet: false });
  const cy = await app.createAgent({ name: 'Cy', greet: false });
  const g = await app.createGroup({ title: 'Team', agentIds: [ada.id, bo.id, cy.id] });
  await app.runtime.send(g.id, { text: 'Which database should we use?' });
  const msgs = (await app.loadMessages(g.id)).filter((m) => m.authorType === 'agent');
  const visible = msgs.filter((m) => !m.hidden).map((m) => [app.getAgent(m.authorId).name, finalText(m)]);
  assert.deepEqual(visible, [['Ada', 'Ada here: use Postgres. @Cy what do you think?'], ['Cy', 'Cy agrees.']]);
  assert.ok(msgs.some((m) => m.hidden && m.authorId === bo.id));
});

test('provider errors mark the message, and a bot without Holly Bot\'s AI is told why', async () => {
  const { app } = await makeApp(async () => {
    throw Object.assign(new Error('DeepSeek error 500: boom'), { status: 500 });
  });
  const holly = await app.createAgent({ name: 'Holly', greet: false });
  const r = await app.runtime.send(`dm_${holly.id}`, { text: 'hi' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /boom/);
  await app.saveSettings({ providers: {} });
  await assert.rejects(async () => app.providers.resolve(holly), /Holly Bot account/);
});

test('delegate_task runs in the background and reports back', async () => {
  let delivered;
  const done = new Promise((r) => { delivered = r; });
  const { app } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    const me = /You are (\w+)/.exec(req.system)?.[1];
    if (me === 'Holly' && /research/i.test(ctx.lastUserText) && !ctx.lastUserText.includes('Task result')) {
      return { toolCalls: [{ id: 'd1', name: 'delegate_task', args: { agent: 'Nova', task: 'Find 3 facts about owls' } }] };
    }
    if (me === 'Holly' && ctx.lastTool?.[0]?.name === 'delegate_task') return { text: 'Nova is on it.' };
    if (me === 'Nova') return { text: 'Owls: 1) silent flight 2) 270° neck 3) asymmetric ears' };
    if (me === 'Holly' && /Task result from Nova/.test(ctx.lastUserText)) {
      setTimeout(delivered, 10);
      return { text: 'Here is what Nova found: silent flight, neck rotation, asymmetric ears.' };
    }
    return { text: 'ok' };
  });
  const holly = await app.createAgent({ name: 'Holly', greet: false });
  await app.createAgent({ name: 'Nova', greet: false });
  await app.runtime.send(`dm_${holly.id}`, { text: 'Please research owls' });
  await done;
  await new Promise((r) => setTimeout(r, 50));
  const msgs = await app.loadMessages(`dm_${holly.id}`);
  const texts = msgs.filter((m) => m.authorType === 'agent').map((m) => finalText(m));
  assert.deepEqual(texts, ['Nova is on it.', 'Owls: 1) silent flight 2) 270° neck 3) asymmetric ears', 'Here is what Nova found: silent flight, neck rotation, asymmetric ears.']);
  const task = [...app.tasks.values()][0];
  assert.equal(task.status, 'done');
});

test('no backup AI: an outage shows on the reply, never goes to another AI, and the next turn tries again', async () => {
  const { ProviderError } = await import('../../src/core/providers/common.js');
  let outage = true;
  const { app, calls } = await makeApp(async (req, ctx) => {
    if (ctx.isMemoryJob) return { text: '{"operations":[]}' };
    if (outage) throw new ProviderError("Holly Bot's AI had a problem answering. Try again in a moment.", { status: 502, provider: "Holly Bot's AI" });
    return { text: 'back again', model: req.cfg.model };
  });
  // A backup chosen before bots ran on Holly Bot's AI is left alone.
  await app.saveSettings({ providers: { ...app.settings.providers, openai: { apiKey: 'sk-o' } }, backup: { provider: 'openai', model: 'gpt-5' } });
  const bot = await app.createAgent({ name: 'Holly', greet: false });
  const threadId = `dm_${bot.id}`;

  await app.runtime.send(threadId, { text: 'hello' });
  let reply = (await app.loadMessages(threadId)).at(-1);
  assert.equal(reply.status, 'error');
  assert.match(reply.error, /had a problem answering/);
  assert.ok(calls.every((c) => c.req.cfg.provider.id === 'deepseek'), 'only Holly Bot\'s AI is asked');

  outage = false;
  await app.runtime.send(threadId, { text: 'hello again' });
  reply = (await app.loadMessages(threadId)).at(-1);
  assert.equal(finalText(reply), 'back again');
  await settle(app);
});
