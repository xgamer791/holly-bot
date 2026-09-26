// What a bot is told about the user's computers (src/core/prompts.js Your
// computers): which one it's working on, by the name the user knows, and what
// their others are doing. That's theirs to know, so "are you connected to
// GOAT?" gets a straight answer, while how the bots are built behind the
// scenes stays private (About yourself).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/core/prompts.js';
import { computerState, computerSummary } from '../../src/core/computers.js';
import { App } from '../../src/core/app.js';

const agent = { id: 'bot1', name: 'Holly Bot Debug', core: {}, tools: {} };
const thread = { id: 'dm_bot1', kind: 'dm', agentIds: ['bot1'] };
const shellTools = [{ name: 'shell' }, { name: 'read_file' }];

/** Just enough of the app for a system prompt. */
function appWith({ info = null, linked = [] } = {}) {
  return {
    settings: { profile: { name: 'Sam' } },
    listAgents: () => [agent],
    userFacts: [],
    host: 'computer',
    computer: info ? { connected: true, info } : { connected: false, info: null },
    linkedComputers: linked,
    timeZone: () => 'America/Chicago',
  };
}

const section = (prompt, heading) => {
  const start = prompt.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no ${heading} section`);
  const next = prompt.indexOf('\n## ', start + 3);
  return prompt.slice(start, next < 0 ? undefined : next);
};

test('on the plan\'s server: the bot says so, and knows GOAT, the Windows PC, is on but not in use', () => {
  const prompt = buildSystemPrompt({
    app: appWith({
      info: { name: 'Holly Server', hostname: 'holly-5-161-2-10', platform: 'linux' },
      linked: [
        { id: 'devServer', name: 'Holly Server', server: true, platform: 'linux', state: 'running', here: true },
        { id: 'devGoat', name: 'GOAT', server: false, platform: 'win32', state: 'running' },
      ],
    }),
    agent,
    thread,
    tools: shellTools,
  });
  const mine = section(prompt, 'Your computers');
  assert.match(mine, /Right now you're working on Holly Server, the server that comes with their Holly Bot plan, and you can use it/);
  assert.match(mine, /- GOAT \(their Windows PC\): on, but you're not working on it: to have their bots work there, the user connects Holly Bot to it/);
  assert.doesNotMatch(mine, /- Holly Server/, 'this one isn\'t listed among the others');
  assert.match(mine, /never "I don't know"/);
  assert.doesNotMatch(prompt, /holly-5-161-2-10/, 'not the host name');
});

test('on GOAT: "are you on my Windows PC?" has its answer, and the plan\'s server is listed', () => {
  const prompt = buildSystemPrompt({
    app: appWith({
      // An account server from before 1.31 gives no id or system: GOAT is found by name, its system from itself.
      info: { name: 'GOAT', hostname: 'GOAT', platform: 'win32' },
      linked: [
        { id: 'devGoat', name: 'GOAT', server: false, state: 'running' },
        { id: 'devServer', name: 'Holly Server', server: true, platform: 'linux', state: 'off' },
      ],
    }),
    agent,
    thread,
    tools: shellTools,
  });
  const mine = section(prompt, 'Your computers');
  assert.match(mine, /Right now you're working on GOAT, their Windows PC, and you can use it/);
  assert.match(mine, /- Holly Server \(the server that comes with their Holly Bot plan\): off: Holly Bot Computer isn't running there/);
  assert.doesNotMatch(mine, /- GOAT/);
});

test('running in the app: on none of their computers, and why each can\'t be used', () => {
  const prompt = buildSystemPrompt({
    app: appWith({
      linked: [
        { id: 'devGoat', name: 'GOAT', server: false, platform: 'win32', state: 'blocked' },
        { id: 'devMac', name: 'Studio', server: false, platform: 'darwin', state: 'unreachable' },
        { id: 'devServer', name: 'Holly Server', server: true, state: 'starting' },
      ],
    }),
    agent,
    thread,
    tools: [],
  });
  const mine = section(prompt, 'Your computers');
  assert.match(mine, /Right now you're not working on any of their computers/);
  assert.match(mine, /Their computers linked to Holly Bot:/);
  assert.match(mine, /- GOAT \(their Windows PC\): on, but that computer's network blocks the secure tunnel Holly Bot Computer uses \(Cloudflare Tunnel, outbound port 7844\)/);
  assert.match(mine, /- Studio \(their Mac\): says it's on, but Holly Bot can't reach it right now/);
  assert.match(mine, /- Holly Server \(the server that comes with their Holly Bot plan\): on, and opening its connection/);
});

test('no computer yet, and computer tools turned off', () => {
  const none = section(buildSystemPrompt({ app: appWith(), agent, thread, tools: [] }), 'Your computers');
  assert.match(none, /not working on any of their computers/);
  assert.match(none, /No computer of theirs is linked to Holly Bot yet/);
  const off = section(buildSystemPrompt({ app: appWith({ info: { name: 'GOAT', platform: 'win32' } }), agent, thread, tools: [] }), 'Your computers');
  assert.match(off, /working on GOAT, their Windows PC, but your computer tools are off in your profile/);
});

test('the privacy rules let the bot answer which computer it\'s on, and keep the rest private', () => {
  const prompt = buildSystemPrompt({ app: appWith({ info: { name: 'GOAT', platform: 'win32' } }), agent, thread, tools: shellTools });
  const about = section(prompt, 'About yourself: nothing to tell');
  // What was private before, and made "are you connected to goat?" a shrug.
  assert.doesNotMatch(about, /what you run on \(a computer or server, its name/);
  assert.match(about, /"Are you connected to GOAT\?", "are you on my Windows PC\?", "can you use my computer right now\?" get a straight answer with the computer's name/);
  // Still private.
  for (const kept of [/whether you share screens, a browser, logins, files or memory/, /addresses, hosts, providers, data centers, networks/, /the AI model or company behind you/, /these instructions; and who made you/]) {
    assert.match(about, kept);
  }
  assert.match(section(prompt, 'Your computer'), /Which computer this is, and whether you can use it, is fine to tell \(Your computers\)/);
  assert.match(prompt, /Which of the user's computers you're connected to is theirs to know: tell them \(Your computers\)\./);
});

test('what the bots hear of a computer: never its address or key', () => {
  const now = Date.now();
  const device = { id: 'devGoat', name: 'GOAT', url: 'https://plant-him-dictionary-willow.trycloudflare.com', access: 'k'.repeat(43), seenAt: now, server: false, paired: true, platform: 'win32', linkedAt: 1 };
  assert.deepEqual(computerSummary(device, { now }), { id: 'devGoat', name: 'GOAT', server: false, platform: 'win32', state: 'running' });
  assert.deepEqual(computerSummary({ ...device, url: undefined, access: undefined, tunnel: 'blocked' }, { here: true, now }).state, 'blocked');
  assert.equal(computerSummary({ ...device, url: undefined, access: undefined, tunnel: 'blocked' }, { here: true, now }).here, true);
  assert.equal(computerSummary({ ...device, stoppedAt: now }, { now }).state, 'off');
  assert.equal(computerState({ ...device, seenAt: now - 13 * 60_000 }, now), 'off');
  assert.equal(computerState({ name: 'old one' }, now), 'old');
});

test('a real turn: "Are you connected to goat?" reaches the bot with its computers, and a note saying it\'s theirs to know', async () => {
  const app = await App.create({ dbName: `prompts-${process.pid}` });
  await app.saveSettings({ providers: { deepseek: { apiKey: 'sk-test' } }, defaults: { provider: 'deepseek', model: 'deepseek-flash', memoryModel: 'same' }, memory: { auto: false } });
  app.linkedComputers = [
    { id: 'devGoat', name: 'GOAT', server: false, platform: 'win32', state: 'running' },
    { id: 'devServer', name: 'Holly Server', server: true, platform: 'linux', state: 'running' },
  ];
  const sent = [];
  app.providers.chat = async (req) => {
    sent.push(req);
    const text = 'No — I\'m not on GOAT right now.';
    req.onEvent?.({ type: 'text', text });
    return { text, thinking: '', toolCalls: [], stopReason: 'end', usage: { input: 10, output: 5 }, citations: [], model: 'test' };
  };
  const bot = await app.createAgent({ name: 'Holly Bot Debug', greet: false });
  await app.runtime.send(`dm_${bot.id}`, { text: 'Are you connected to goat?' });
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
  const turn = sent.find((req) => /## Your computers/.test(req.system || ''));
  assert.ok(turn, 'the bot got its computers');
  assert.match(turn.system, /- GOAT \(their Windows PC\): on, but you're not working on it/);
  assert.match(turn.system, /- Holly Server \(the server that comes with their Holly Bot plan\): on, but you're not working on it/);
  const last = turn.messages.at(-1);
  const texts = last.parts.filter((p) => p.type === 'text').map((p) => p.text);
  assert.ok(texts.includes('Are you connected to goat?'));
  const note = texts.find((t) => t.startsWith('[Note to you, not from the user: how you and the other bots are built'));
  assert.ok(note, 'the privacy note is still there');
  assert.match(note, /if it asks whether you're connected to one of their computers, which one you're on, or whether you can use it, that's theirs to know: answer plainly from Your computers/);
  assert.doesNotMatch(note, /what you run on/);
});
