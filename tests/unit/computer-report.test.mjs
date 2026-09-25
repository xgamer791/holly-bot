// What a linked Holly Computer tells the account about where it can be
// reached (computer/src/home.mjs report, convex/devices.ts report): its
// address while its tunnel works, and otherwise why there's none, which an
// account server from before that doesn't take: then it's left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotHome } from '../../computer/src/home.mjs';

/** A linked account link that records what it's asked, answering with `answer`. */
function linkedAccount(answer = () => ({ server: false })) {
  const calls = [];
  return {
    calls,
    linked: true,
    userId: 'user1',
    accessKey: 'k'.repeat(43),
    async authed(kind, name, args) {
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
    { url: 'https://plant-him-dictionary-willow.trycloudflare.com', access: 'k'.repeat(43) },
    { url: '', access: '', tunnel: 'blocked' },
    { url: '', access: '', tunnel: 'starting' },
    { url: '', access: '' },
  ]);
  assert.ok(account.calls.every((c) => c.kind === 'mutation' && c.name === 'devices:report'));
});

test('an account server that doesn\'t take `tunnel` yet still hears there\'s no address', async () => {
  const account = linkedAccount((args) => {
    if ('tunnel' in args) throw new Error('ArgumentValidationError: Object contains extra field `tunnel` that is not in the validator.');
    return { server: false };
  });
  const home = new BotHome({ dataDir: '/nonexistent', account, computer: {}, log: quiet });
  await home.setAddress(null, { tunnel: 'blocked' });
  await home.setAddress(null, { tunnel: 'starting' });
  assert.deepEqual(account.calls.map((c) => c.args), [
    { url: '', access: '', tunnel: 'blocked' },
    { url: '', access: '' },
    // From then on it isn't sent at all.
    { url: '', access: '' },
  ]);
  assert.equal(home.reportFailed, false);
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
