// End-to-end: Gmail and GitHub connected in Settings → Plugins, then a bot
// emailing on instruction, in the real app (Chromium, iPhone viewport). A
// stand-in for Holly Bot's server answers the account's calls the way
// convex/data.ts and convex/connectors.ts do (their own tests are in
// tests/convex), a stand-in consent screen sends the app back the way the
// callback does, and the model is scripted (mock-xai.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { mockXai, textResponse, toolResponse } from './mock-xai.mjs';

const PORT = Number(process.env.E2E_PORT || 8767);
const ORIGIN = `http://localhost:${PORT}`;
const CONVEX = 'https://impressive-ferret-800.convex.cloud';
const NS = CONVEX.replace(/[^a-zA-Z0-9]/g, '');
const USER = { id: 'user1', name: 'Sam Rivera', email: 'sam@example.com', providers: ['google'] };

let server;
let browser;
let page;
const errors = [];
const log = [];
const calls = []; // what the app asked Holly Bot's server
const chat = () => page.locator('.pane-chat');
const called = (path) => calls.filter((c) => c.path === path);

/** Holly Bot's server: the account's records, and its connections. */
function hollyServer() {
  const records = new Map();
  let version = 0;
  let connections = [];
  const rowOf = (r) => ({ key: r.key, data: r.data });
  const fns = {
    'account:viewer': () => USER,
    // A subscribed account, so the app opens (src/main.js asks first).
    'billing:status': () => ({
      active: true, ready: true, check: false, plans: [],
      subscription: { plan: 'starter', interval: 'month', status: 'active', periodEnd: Date.now() + 30 * 86_400_000 },
    }),
    'devices:list': () => [],
    'data:version': () => version,
    'data:list': ({ store, group }) => ({ page: [...records.values()].filter((r) => r.store === store && (group === undefined || r.group === group)).map(rowOf), isDone: true, continueCursor: '' }),
    'data:tail': ({ store, group, limit }) => [...records.values()].filter((r) => r.store === store && r.group === group).sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0)).slice(0, limit).map(rowOf),
    'data:get': ({ store, key }) => {
      const r = records.get(`${store}\u0000${key}`);
      return r ? rowOf(r) : null;
    },
    'data:apply': ({ ops }) => {
      for (const op of ops) {
        if (op.op === 'delete') records.delete(`${op.store}\u0000${op.key}`);
        else records.set(`${op.store}\u0000${op.key}`, op);
      }
      return { prev: version, version: ++version };
    },
    'data:claim': () => true,
    'connectors:available': () => ({ gmail: true, outlook: false, github: true, githubToken: true }),
    'connectors:list': () => connections,
    'e2e:outdated': () => {
      connections = connections.map((c) => (c.service === 'gmail' ? { ...c, outdated: true } : c));
      return null;
    },
    'connectors:start': ({ service, returnTo }) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=google-id&state=state-1&service=${service}&back=${encodeURIComponent(returnTo)}`,
    'connectors:claim': ({ claim }) => {
      if (claim !== 'claim-123') return { error: 'That connection has expired. Connect it again.' };
      connections = [...connections.filter((c) => c.service !== 'gmail'), { service: 'gmail', account: 'sam@gmail.com', via: 'oauth', connectedAt: Date.now() }];
      return { service: 'gmail', account: 'sam@gmail.com' };
    },
    'connectors:connectToken': ({ token }) => {
      if (!/^ghp_\w{36}$/.test(token)) throw Object.assign(new Error('refused'), { data: "That doesn't look like a GitHub token. They start with github_pat_ or ghp_." });
      connections = [...connections.filter((c) => c.service !== 'github'), { service: 'github', account: 'octo', via: 'token', connectedAt: Date.now() }];
      return { service: 'github', account: 'octo' };
    },
    'connectors:disconnect': ({ service }) => {
      connections = connections.filter((c) => c.service !== service);
      return null;
    },
    'connectors:run': ({ service, op, args }) => {
      if (service === 'gmail' && op === 'send') return { sent: true, id: 's1', threadId: 't1', to: args.to, cc: [], bcc: [], subject: args.subject };
      if (service === 'gmail' && op === 'peek') {
        return { total: 12, ids: Array.from({ length: 12 }, (_, i) => `d${i + 1}`), named: Array.from({ length: 8 }, (_, i) => ({ id: `d${i + 1}`, from: 'Deals', subject: `Sale ${i + 1}`, date: '2026-09-21T09:00:00Z' })) };
      }
      if (service === 'gmail' && op === 'delete') return { deleted: args.ids.length, forever: !!args.forever, ids: args.ids, failed: [] };
      throw Object.assign(new Error('refused'), { data: `${service} ${op} isn't expected here` });
    },
  };
  return async (route) => {
    const req = route.request();
    const kind = new URL(req.url()).pathname.split('/').pop();
    const { path, args } = JSON.parse(req.postData() || '{}');
    const a = args?.[0] ?? {};
    calls.push({ kind, path, args: a, auth: req.headers().authorization || '' });
    let body;
    try {
      if (!fns[path]) throw new Error(`Could not find public function for '${path}'`);
      body = { status: 'success', value: (await fns[path](a)) ?? null, logLines: [] };
    } catch (err) {
      body = { status: 'error', errorMessage: err.message, ...(err.data !== undefined ? { errorData: err.data } : {}), logLines: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  };
}

function script(d) {
  if (d.isMemoryJob) return textResponse('{"operations":[]}');
  if (d.lastToolName === 'gmail_send') return textResponse(/denied/.test(d.lastTool.output) ? 'Okay, not sent.' : 'Sent — I told Anna you’re running late.');
  if (d.lastToolName === 'github_delete_repo') return textResponse(/denied/.test(d.lastTool.output) ? 'Okay, I kept octo/old-stuff.' : 'Deleted.');
  if (d.lastToolName === 'gmail_delete') return textResponse(/denied/.test(d.lastTool.output) ? 'Okay, I left them.' : 'Done: they’re in Trash.');
  if (/deals emails forever/i.test(d.lastUserText)) return toolResponse([{ name: 'gmail_delete', args: { query: 'from:deals', forever: true } }]);
  if (/deals emails/i.test(d.lastUserText)) return toolResponse([{ name: 'gmail_delete', args: { query: 'from:deals' } }]);
  if (/running late/i.test(d.lastUserText)) {
    return toolResponse([{ name: 'gmail_send', args: { to: ['anna@example.com'], subject: 'Running late', body: 'Hi Anna,\n\nI’m running 15 minutes late — sorry!\n\nSam' } }]);
  }
  if (/delete the repo/i.test(d.lastUserText)) return toolResponse([{ name: 'github_delete_repo', args: { repo: 'octo/old-stuff' } }]);
  return textResponse('Hi Sam!');
}

before(async () => {
  process.argv[2] = String(PORT);
  server = (await import('../../scripts/serve.mjs')).default;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  // Signed in: a session as Convex Auth leaves it in the browser.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: `${USER.id}|session1`, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  await ctx.addInitScript(({ ns, jwt, user }) => {
    localStorage.setItem(`__convexAuthJWT_${ns}`, jwt);
    localStorage.setItem(`__convexAuthRefreshToken_${ns}`, 'refresh-1');
    localStorage.setItem('holly.account', JSON.stringify(user));
  }, { ns: NS, jwt, user: USER });
  await ctx.route(`${CONVEX}/api/**`, hollyServer());
  // Google's consent screen, approved: the callback sends the app back with a claim.
  await ctx.route('https://accounts.google.com/**', (route) => {
    const back = new URL(new URL(route.request().url()).searchParams.get('back'));
    back.search = '?nosw&signin&connect=claim-123';
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await mockXai(page, script, log);
  await page.goto(`${ORIGIN}/?nosw&signin`);
  await page.waitForSelector('.pane-list');
});

after(async () => {
  await browser?.close();
  server?.close();
});

const openPlugins = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Plugins/ }).click();
  await page.getByText('Connected accounts').waitFor();
};
/** Back out of every open sheet (a sub-page shows Back, the top one Close). */
const closeSheets = async () => {
  for (let i = 0; i < 12 && (await page.locator('section.sheet').count()); i++) {
    const sheet = page.locator('section.sheet').last();
    const back = sheet.getByRole('button', { name: 'Back', exact: true });
    await ((await back.count()) ? back.first() : sheet.getByRole('button', { name: 'Close', exact: true }).first()).click();
    await page.waitForTimeout(250);
  }
};

test('Settings → Plugins offers Gmail, Outlook and GitHub', async () => {
  await openPlugins();
  const gmail = page.getByRole('button', { name: /^Gmail/ });
  await gmail.getByText('Connect', { exact: true }).waitFor();
  await page.getByText('Not set up on Holly Bot\'s server yet').waitFor(); // Outlook: no app on this server
  assert.equal(await page.getByRole('button', { name: /^Outlook/ }).count(), 0, 'Outlook can\'t be tapped');
  await page.getByRole('button', { name: /^GitHub/ }).first().getByText('Connect', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Connect GitHub with a token instead/ }).waitFor();
});

test('Connect Gmail: to the consent screen and back, claimed for this account', async () => {
  await page.getByRole('button', { name: /^Gmail/ }).click();
  await page.getByText('Gmail is connected: sam@gmail.com').waitFor();
  const [start] = called('connectors:start');
  assert.deepEqual(start.args, { service: 'gmail', returnTo: `${ORIGIN}/` });
  assert.match(start.auth, /^Bearer /, 'started as the signed-in account');
  assert.deepEqual(called('connectors:claim').map((c) => c.args), [{ claim: 'claim-123' }]);
  assert.ok(!page.url().includes('connect='), 'the claim is cleaned out of the address');
  // Settings → Plugins opens on the result.
  const gmail = page.getByRole('button', { name: /^Gmail/ });
  await gmail.getByText(/sam@gmail\.com/).waitFor();
  await gmail.getByText('Disconnect').waitFor();
});

test('Connect GitHub with a token, checked by the server', async () => {
  await page.getByRole('button', { name: /Connect GitHub with a token instead/ }).click();
  const input = page.getByPlaceholder('github_pat_…');
  assert.equal(await input.getAttribute('type'), 'password');
  await input.fill('not-a-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText("That doesn't look like a GitHub token.", { exact: false }).waitFor();
  await page.getByRole('button', { name: /Connect GitHub with a token instead/ }).click();
  await page.getByPlaceholder('github_pat_…').fill(`ghp_${'a1B2'.repeat(9)}`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('GitHub connected: octo').waitFor();
  await page.getByRole('button', { name: /^GitHub/ }).getByText(/octo/).waitFor();
  assert.equal(await page.getByRole('button', { name: /Connect GitHub with a token instead/ }).count(), 0);
  await closeSheets();
});

test('a bot emails on instruction, after the person approves exactly what goes out', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^API Keys/ }).click();
  await page.getByText('xAI (Grok)').click();
  await page.getByPlaceholder('xai-…').fill('xai-test-key');
  await page.getByRole('button', { name: 'Save & test connection' }).click();
  await page.getByText(/Connected — \d+ models available/).waitFor();
  await closeSheets();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Bot' }).click();
  await page.getByLabel('Bot name').fill('Holly');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await chat().getByText('What should I focus on first?').waitFor();

  await page.getByLabel('Ask Holly').fill("Email anna@example.com that I'm running late");
  await page.getByRole('button', { name: 'Send' }).click();
  const card = chat().getByRole('group', { name: 'Permission required' });
  await card.waitFor();
  await card.getByText('Holly wants to email anna@example.com with Gmail:').waitFor();
  assert.equal(await card.locator('.cmd').innerText(), 'From: sam@gmail.com\nTo: anna@example.com\nSubject: Running late\n\nHi Anna,\n\nI’m running 15 minutes late — sorry!\n\nSam');
  await card.getByRole('button', { name: 'Always allow' }).waitFor();
  assert.equal(called('connectors:run').length, 0, 'nothing sent before approval');
  const request = log.find((d) => !d.isMemoryJob && /running late/i.test(d.lastUserText));
  assert.ok(request.tools.includes('gmail_send') && request.tools.includes('github_write_file'), 'the model was offered the connected services');
  assert.ok(!request.tools.some((name) => name.startsWith('outlook_')), 'and not Outlook');
  assert.match(request.instructions, /## The user's connected accounts\n- Gmail: sam@gmail\.com\n- GitHub: octo/);
  await card.getByRole('button', { name: 'Approve' }).click();
  await chat().getByText('Sent — I told Anna you’re running late.').waitFor();
  const [run] = called('connectors:run');
  assert.equal(run.args.service, 'gmail');
  assert.equal(run.args.op, 'send');
  assert.deepEqual(run.args.args.to, ['anna@example.com']);
  assert.equal(run.args.args.subject, 'Running late');
});

test('deleting a repository asks every time, with no Always allow', async () => {
  await page.getByLabel('Ask Holly').fill('Delete the repo octo/old-stuff');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = chat().getByRole('group', { name: 'Permission required' });
  await card.waitFor();
  await card.getByText("This can't be undone.", { exact: false }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Always allow' }).count(), 0);
  await card.getByRole('button', { name: 'Deny' }).click();
  await chat().getByText('Okay, I kept octo/old-stuff.').waitFor();
  assert.ok(!called('connectors:run').some((c) => c.args.op === 'delete_repo'));
});

test('deleting email: the card shows exactly which emails, and for good has no Always allow', async () => {
  await page.getByLabel('Ask Holly').fill('Delete the deals emails');
  await page.getByRole('button', { name: 'Send' }).click();
  let card = chat().getByRole('group', { name: 'Permission required' });
  await card.getByText('Holly wants to delete emails matching “from:deals” in Gmail:').waitFor();
  const summary = await card.locator('.cmd').innerText();
  assert.match(summary, /^Move 12 emails in sam@gmail\.com to Trash\. Gmail keeps them there for 30 days\.\n\n• Deals — Sale 1 · .+/);
  assert.match(summary, /• Deals — Sale 8 · .+\n…and 4 more$/);
  await card.getByRole('button', { name: 'Always allow' }).waitFor();
  assert.equal(called('connectors:run').filter((c) => c.args.op === 'delete').length, 0, 'nothing deleted before approval');
  await card.getByRole('button', { name: 'Approve' }).click();
  await chat().getByText('Done: they’re in Trash.').waitFor();
  const del = called('connectors:run').find((c) => c.args.op === 'delete');
  assert.deepEqual(del.args.args.ids, Array.from({ length: 12 }, (_, i) => `d${i + 1}`), 'exactly the emails shown');

  await page.getByLabel('Ask Holly').fill('Delete the deals emails forever');
  await page.getByRole('button', { name: 'Send' }).click();
  card = chat().getByRole('group', { name: 'Permission required' });
  await card.getByText('Holly wants to permanently delete emails matching “from:deals” in Gmail:').waitFor();
  await card.getByText("Delete 12 emails in sam@gmail.com forever. This can't be undone.", { exact: false }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Always allow' }).count(), 0);
  await card.getByRole('button', { name: 'Deny' }).click();
  await chat().getByText('Okay, I left them.').waitFor();
  assert.ok(!called('connectors:run').some((c) => c.args.op === 'delete' && c.args.args.forever));
});

test('a Gmail connection from before deleting offers to connect again', async () => {
  await page.evaluate((url) => fetch(`${url}/api/mutation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'e2e:outdated', args: [{}] }) }), CONVEX);
  await page.evaluate(() => { location.hash = '#/'; });
  await openPlugins();
  await page.getByRole('button', { name: /Connect Gmail again/ }).getByText('It was connected before bots could delete email', { exact: false }).waitFor();
  await closeSheets();
});

test('Disconnect Gmail', async () => {
  await page.evaluate(() => { location.hash = '#/'; });
  await openPlugins();
  await page.getByRole('button', { name: /^Gmail/ }).click();
  await page.getByText('Disconnect Gmail?').waitFor();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: /^Gmail/ }).getByText('Connect', { exact: true }).waitFor();
  assert.deepEqual(called('connectors:disconnect').map((c) => c.args), [{ service: 'gmail' }]);
  await closeSheets();
});

test('no errors in the page', () => {
  assert.deepEqual(errors, []);
});
