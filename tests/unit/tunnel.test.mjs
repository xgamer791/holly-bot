// Holli Bot Computer's tunnel (computer/src/tunnel.mjs): an address goes to the
// account only once cloudflared has connected and the address answers as this
// computer, and a tunnel that stops working is replaced. A stand-in
// cloudflared plays each way a real one behaves, including the one that broke
// phones: an address handed out on a network that blocks Cloudflare Tunnel,
// which never connects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TunnelKeeper, checkAddress, tunnelOrigin, QUICK_URL } from '../../computer/src/tunnel.mjs';

let dir;
/** Every keeper a test made, stopped at the end even when a test fails. */
const keepers = [];

/** A stand-in cloudflared. Each start follows the next step of `plan.json`
 * (the last one repeats): print `url` (as cloudflared's box does), say it
 * `register`s, `lose`s the connection or fails its network checks
 * (`blocked`) after so many ms, or `exit`s. It notes each start's arguments. */
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const countFile = path.join(dir, 'count');
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0);
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(path.join(dir, 'runs'), JSON.stringify({ bin: path.basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const step = plan[Math.min(n, plan.length - 1)];
const log = (text) => process.stderr.write('2026-09-25T21:55:45Z INF ' + text + '\\n');
log('Requesting new quick Tunnel on trycloudflare.com...');
if (step.url) setTimeout(() => {
  log('+--------------------------------------------------------------------------------------------+');
  log('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  log('|  ' + step.url + '                                     |');
  log('+--------------------------------------------------------------------------------------------+');
}, 10);
if (step.blocked) setTimeout(() => log('precheck complete hard_fail=true run_id=c84594b8'), 30);
if (step.register != null) setTimeout(() => log('Registered tunnel connection connIndex=0 connection=9f2 event=0 ip=198.41.200.13 location=ord08 protocol=quic'), step.register);
if (step.lose != null) setTimeout(() => process.stderr.write('2026-09-25T21:56:00Z ERR Connection terminated error="timeout: no recent network activity" connIndex=0\\n'), step.lose);
if (step.exit != null) setTimeout(() => process.exit(1), step.exit);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

/** Fast timings, so a test takes a second or two. */
const FAST = { urlMs: 800, connectMs: 500, verifyTries: 2, verifyGapMs: 30, watchMs: 80, lostMs: 250, failLimit: 2, againMs: 40, backoffMs: [60, 120] };

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'holly-tunnel-'));
});

after(() => {
  for (const t of keepers) t.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh stand-in in its own folder, following `plan`. */
function fake(plan, name = 'cloudflared') {
  const home = mkdtempSync(join(dir, 'cf-'));
  const bin = join(home, name);
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(join(home, 'plan.json'), JSON.stringify(plan));
  return {
    bin,
    home,
    /** Each start so far: { bin, args }. */
    runs: () => (existsSync(join(home, 'runs')) ? readFileSync(join(home, 'runs'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/** A keeper on the stand-in, with what it told the account. */
function keeper(cf, answers, extra = {}) {
  const changes = [];
  const t = new TunnelKeeper({
    port: 8787,
    bin: cf.bin,
    instance: 'this-one',
    check: async (url) => (typeof answers === 'function' ? answers(url) : answers[url] || 'down'),
    onChange: (change) => changes.push(change),
    log: { warn() {}, log() {} },
    timing: FAST,
    ...extra,
  });
  keepers.push(t);
  return { t, changes, urls: () => changes.map((c) => c.url) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const A = 'https://plant-him-dictionary-willow.trycloudflare.com';
const B = 'https://second-tunnel-words-here.trycloudflare.com';

test('an address from a tunnel that never connects is never told, and the network is said to block it', async () => {
  // What happened on a network that blocks port 7844: cloudflared names an
  // address, fails its checks, and never connects.
  const cf = fake([{ url: A, blocked: true }]);
  const { t, changes } = keeper(cf, { [A]: 'ok' });
  const first = await t.start({ waitMs: 3000 });
  assert.equal(first, null, 'no address to give');
  assert.equal(t.state, 'blocked');
  await until('another try', () => cf.runs().length >= 3);
  t.stop();
  assert.ok(changes.every((c) => c.url === null), `never an address: ${JSON.stringify(changes)}`);
  assert.ok(changes.some((c) => c.state === 'blocked'));
  // It tries HTTP/2 straight away the next time, in case only QUIC is blocked.
  const protocols = cf.runs().map((r) => (r.args.includes('--protocol') ? r.args[r.args.indexOf('--protocol') + 1] : 'auto'));
  assert.deepEqual(protocols.slice(0, 3), ['auto', 'http2', 'auto']);
});

test('the address is told once cloudflared has connected and it answers as this computer', async () => {
  const cf = fake([{ url: A, register: 60 }]);
  const { t, changes } = keeper(cf, { [A]: 'ok' });
  const url = await t.start({ waitMs: 3000 });
  assert.equal(url, A);
  assert.equal(t.state, 'up');
  assert.deepEqual(changes, [{ url: A, state: 'up', why: '' }]);
  // cloudflared reaches Holli Bot Computer on 127.0.0.1, not "localhost" (which can mean ::1).
  assert.deepEqual(cf.runs()[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787']);
  t.stop();
});

test('an address where something else answers is not told: a new tunnel opens instead', async () => {
  const cf = fake([{ url: A, register: 40 }, { url: B, register: 40 }]);
  const { t, urls } = keeper(cf, { [A]: 'down', [B]: 'ok' });
  assert.equal(await t.start({ waitMs: 4000 }), B);
  assert.ok(!urls().includes(A), 'the dead address never went to the account');
  assert.equal(cf.runs().length, 2);
  t.stop();
});

test('connected, but the address can\'t be checked from here: it is told all the same', async () => {
  const cf = fake([{ url: A, register: 40 }]);
  const { t } = keeper(cf, { [A]: 'unknown' });
  assert.equal(await t.start({ waitMs: 3000 }), A);
  t.stop();
});

test('an address that stops answering is taken back, and a new tunnel takes its place', async () => {
  const cf = fake([{ url: A, register: 40 }, { url: B, register: 40 }]);
  let aWorks = true;
  const { t, changes } = keeper(cf, (url) => (url === A ? (aWorks ? 'ok' : 'down') : 'ok'));
  assert.equal(await t.start({ waitMs: 3000 }), A);
  aWorks = false; // Cloudflare stops routing it
  await until('the new address', () => t.url === B);
  assert.deepEqual(changes.map((c) => c.url), [A, null, B]);
  assert.equal(changes[1].why, 'not-answering');
  t.stop();
});

test('a tunnel that closes by itself is replaced', async () => {
  const cf = fake([{ url: A, register: 40, exit: 400 }, { url: B, register: 40 }]);
  const { t, changes } = keeper(cf, { [A]: 'ok', [B]: 'ok' });
  assert.equal(await t.start({ waitMs: 3000 }), A);
  await until('the new address', () => t.url === B);
  assert.deepEqual(changes.map((c) => [c.url, c.state]), [[A, 'up'], [null, 'starting'], [B, 'up']]);
  t.stop();
});

test('cloudflared losing Cloudflare for a while opens a new tunnel', async () => {
  const cf = fake([{ url: A, register: 40, lose: 200 }, { url: B, register: 40 }]);
  const { t } = keeper(cf, { [A]: 'ok', [B]: 'ok' });
  assert.equal(await t.start({ waitMs: 3000 }), A);
  await until('the new address', () => t.url === B);
  t.stop();
});

test('api.trycloudflare.com, named when asking for a tunnel fails, is never taken for the address', async () => {
  assert.equal(QUICK_URL.exec('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
  assert.equal(QUICK_URL.exec(`|  ${A}  |`)?.[0], A);
  const cf = fake([{ url: 'https://api.trycloudflare.com', register: 20 }, { url: A, register: 40 }]);
  const { t, urls } = keeper(cf, { 'https://api.trycloudflare.com': 'ok', [A]: 'ok' });
  assert.equal(await t.start({ waitMs: 4000 }), A);
  assert.deepEqual(urls(), [A]);
  t.stop();
});

test('after the cloudflared found here fails to connect twice, its own copy is tried', async () => {
  const found = fake([{ url: A }]);
  const own = fake([{ url: B, register: 40 }], 'own-cloudflared');
  const { t, changes } = keeper(found, { [B]: 'ok' }, { ownBin: async () => own.bin });
  // Twice without connecting reads as a network that blocks the tunnel...
  assert.equal(await t.start({ waitMs: 5000 }), null);
  assert.equal(t.state, 'blocked');
  // ...and then its own cloudflared gets through.
  await until('its own copy connecting', () => t.url === B);
  assert.deepEqual(changes.map((c) => [c.url, c.state]).slice(-1), [[B, 'up']]);
  assert.equal(found.runs().length, 2);
  assert.equal(own.runs().length, 1);
  t.stop();
});

test('stop() ends cloudflared and any more tries', async () => {
  const cf = fake([{ url: A, register: 40 }]);
  const { t } = keeper(cf, { [A]: 'ok' });
  await t.start({ waitMs: 3000 });
  t.stop();
  assert.equal(t.state, 'stopped');
  const runs = cf.runs().length;
  await sleep(400);
  assert.equal(cf.runs().length, runs, 'no new tunnel after stop');
});

test('cloudflared that can\'t be had is asked for again, with a pause', async () => {
  let asked = 0;
  const cf = fake([{ url: A, register: 40 }]);
  const { t } = keeper(cf, { [A]: 'ok' }, {
    bin: async () => {
      asked++;
      if (asked < 2) throw new Error('offline');
      return cf.bin;
    },
  });
  assert.equal(await t.start({ waitMs: 3000 }), A);
  assert.equal(asked, 2);
  t.stop();
});

test('tunnelOrigin: 127.0.0.1 unless Holli Bot Computer listens on one address only', () => {
  assert.equal(tunnelOrigin(undefined, 8787), 'http://127.0.0.1:8787');
  assert.equal(tunnelOrigin('127.0.0.1', 8787), 'http://127.0.0.1:8787');
  assert.equal(tunnelOrigin('0.0.0.0', 8787), 'http://127.0.0.1:8787');
  assert.equal(tunnelOrigin('localhost', 9000), 'http://127.0.0.1:9000');
  assert.equal(tunnelOrigin('::', 8787), 'http://127.0.0.1:8787');
  assert.equal(tunnelOrigin('192.168.1.20', 8787), 'http://192.168.1.20:8787');
  assert.equal(tunnelOrigin('::1', 8787), 'http://[::1]:8787');
});

test('checkAddress tells this computer from Cloudflare\'s page and from no answer at all', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'holly-computer', instance: 'this-one' }));
      return;
    }
    // What Cloudflare answers for a quick tunnel that isn't connected: error 1033, as a web page.
    res.writeHead(530, { 'Content-Type': 'text/html' });
    res.end('<html><title>Cloudflare Tunnel error | trycloudflare.com | Cloudflare</title>Error 1033</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await checkAddress(`http://127.0.0.1:${port}`, { instance: 'this-one' }), 'ok');
    assert.equal(await checkAddress(`http://127.0.0.1:${port}`, { instance: 'another-run' }), 'down');
    assert.equal(await checkAddress(`http://127.0.0.1:${port}/not-connected`, { instance: 'this-one' }), 'down');
    // Nothing listening: no word on the address itself.
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const dead = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    assert.equal(await checkAddress(`http://127.0.0.1:${dead}`), 'unknown');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
