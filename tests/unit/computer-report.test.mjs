// What a linked Holli Bot Computer tells the account about where it can be
// reached (computer/src/home.mjs report, convex/devices.ts report): its
// address while its tunnel works, and otherwise why there's none, and its
// system, which an account server from before that doesn't take: then
// they're left out. And what its bots hear of the account's computers
// (refreshComputers): which one they're on, never an address or key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotHome } from '../../computer/src/home.mjs';

const PLATFORM = process.platform;

/** A linked account link that records what it's asked, answering reports
 * with `answer`, and devices:list with `list`. */
function linkedAccount(answer = () => ({ server: false }), list = () => []) {
  const calls = [];
  return {
    calls,
    linked: true,
    userId: 'user1',
    name: 'GOAT',
    accessKey: 'k'.repeat(43),
    async authed(kind, name, args) {
      if (name === 'devices:list') return list();
      calls.push({ kind, name, args: { ...args } });
      return answer(args, calls.length);
    },
  };
}

const quiet = { warn() {}, log() {} };

test('a working address goes with the access key; without one, why', async () => {
  const account = linkedAccount();
  const home = new BotHome({ dataDir: '/nonexistent', account, computer: {}, log: quiet });
  await home.setAddress('https://plant-him-dictionary-willow.trycloudflare.com/', { tunnel: 'up' });
  await home.setAddress(null, { tunnel: 'blocked' });
  await home.setAddress(null, { tunnel: 'starting' });
  await home.setAddress(null, { tunnel: 'something-else' });
  assert.deepEqual(account.calls.map((c) => c.args), [
    { url: 'https://plant-him-dictionary-willow.trycloudflare.com', access: 'k'.repeat(43), platform: PLATFORM },
    { url: '', access: '', tunnel: 'blocked', platform: PLATFORM },
    { url: '', access: '', tunnel: 'starting', platform: PLATFORM },
    { url: '', access: '', platform: PLATFORM },
  ]);
  assert.ok(account.calls.every((c) => c.kind === 'mutation' && c.name === 'devices:report'));
});

test('an account server that doesn\'t take `tunnel` or `platform` yet still hears there\'s no address', async () => {
  const account = linkedAccount((args) => {
    if ('tunnel' in args || 'platform' in args) throw new Error(`ArgumentValidationError: Object contains extra field \`${'tunnel' in args ? 'tunnel' : 'platform'}\` that is not in the validator.`);
    return { server: false };
  });
  const home = new BotHome({ dataDir: '/nonexistent', account, computer: {}, log: quiet });
  await home.setAddress(null, { tunnel: 'blocked' });
  await home.setAddress(null, { tunnel: 'starting' });
  await home.setAddress('https://x.trycloudflare.com', { tunnel: 'up' });
  assert.deepEqual(account.calls.map((c) => c.args), [
    { url: '', access: '', tunnel: 'blocked', platform: PLATFORM },
    { url: '', access: '' },
    // From then on neither is sent.
    { url: '', access: '' },
    { url: 'https://x.trycloudflare.com', access: 'k'.repeat(43) },
  ]);
  assert.equal(home.reportFailed, false);
});

test('its bots hear of the account\'s computers: which one they\'re on, and what the others are doing, never an address or key', async () => {
  const now = Date.now();
  const list = [
    { id: 'devGoat', name: 'GOAT', linkedAt: 1, url: 'https://a.trycloudflare.com', access: 'k'.repeat(43), seenAt: now, server: false, paired: true, platform: 'win32' },
    { id: 'devServer', name: 'Holli Server', linkedAt: 2, url: 'https://1-2-3-4.sslip.io', access: 's'.repeat(43), seenAt: now, server: true, paired: false, platform: 'linux' },
    { id: 'devOld', name: 'Laptop', linkedAt: 3, seenAt: now - 60 * 60_000, server: false, paired: false },
  ];
  const account = linkedAccount(() => ({ server: false, id: 'devGoat' }), () => list);
  const home = new BotHome({ dataDir: '/nonexistent', account, computer: {}, log: quiet });
  home.app = { linkedComputers: [] };
  await home.setAddress('https://a.trycloudflare.com', { tunnel: 'up' });
  await home.refreshComputers();
  assert.equal(home.deviceId, 'devGoat');
  assert.deepEqual(home.app.linkedComputers, [
    { id: 'devGoat', name: 'GOAT', server: false, platform: 'win32', state: 'running', here: true },
    { id: 'devServer', name: 'Holli Server', server: true, platform: 'linux', state: 'running' },
    { id: 'devOld', name: 'Laptop', server: false, state: 'off' },
  ]);
  assert.doesNotMatch(JSON.stringify(home.app.linkedComputers), /trycloudflare|sslip|kkkk|ssss/);
  // An account server from before 1.31 doesn't say which it is: then it goes by name.
  const older = linkedAccount(() => ({ server: false }), () => list);
  const home2 = new BotHome({ dataDir: '/nonexistent', account: older, computer: {}, log: quiet });
  await home2.setAddress('https://a.trycloudflare.com', { tunnel: 'up' });
  await home2.refreshComputers();
  assert.equal(home2.computers.find((c) => c.here)?.name, 'GOAT');
  // Unlinked: nothing of the account's computers is kept.
  home.forgetComputers();
  assert.deepEqual(home.app.linkedComputers, []);
  assert.equal(home.deviceId, null);
});

test('stopping says so, without an address or why', async () => {
  const account = linkedAccount();
  const home = new BotHome({ dataDir: '/nonexistent', account, computer: {}, log: quiet });
  await home.setAddress(null, { tunnel: 'blocked' });
  home.closing = true;
  await home.report({ stopping: true });
  assert.deepEqual(account.calls.at(-1).args, { url: '', access: '', stopping: true });
  // Nothing more once it's closing.
  await home.setAddress('https://x.trycloudflare.com', { tunnel: 'up' });
  assert.equal(account.calls.length, 2);
});
