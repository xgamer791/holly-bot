// Gmail, Outlook and GitHub connectors (convex/lib/*.ts, the code
// convex/connectors.ts runs): each call checked against a stand-in for the
// service that answers the way the real API does, and GitHub's public API
// checked for real (skipped offline). Node loads the TypeScript straight in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../../convex/lib/seal.ts';
import * as oauth from '../../convex/lib/oauth.ts';
import * as mail from '../../convex/lib/mail.ts';
import * as gh from '../../convex/lib/github.ts';

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i * 7 + 1)).toString('base64');

/** A stand-in service: `routes(req)` answers each request, and every request is kept. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const req = {
      url: String(url),
      method: init.method || 'GET',
      headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body,
    };
    req.json = () => JSON.parse(req.body);
    req.form = () => Object.fromEntries(new URLSearchParams(req.body));
    calls.push(req);
    const out = await routes(req, calls.length);
    if (out instanceof Response) return out;
    const { status = 200, json, text, headers = {} } = out || {};
    const body = json !== undefined ? JSON.stringify(json) : text ?? '';
    return new Response(status === 204 ? null : body, { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  f.calls = calls;
  return f;
}

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');

// ----- sealing tokens ---------------------------------------------------------------

test('seal: tokens round-trip, bound to their account and service', async () => {
  const tokens = { accessToken: 'ya29.secret', refreshToken: '1//refresh', expiresAt: 123, scopes: ['a'] };
  const sealed = await seal(KEY, tokens, 'user1:gmail');
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes('ya29'), 'the token is not readable in the sealed value');
  assert.deepEqual(await unseal(KEY, sealed, 'user1:gmail'), tokens);
  // Moved to another account or service, it doesn't open.
  await assert.rejects(unseal(KEY, sealed, 'user2:gmail'));
  await assert.rejects(unseal(KEY, sealed, 'user1:github'));
  // Another key doesn't open it, nor does a changed byte.
  const other = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
  await assert.rejects(unseal(other, sealed, 'user1:gmail'));
  const [v, iv, ct] = sealed.split('.');
  const flipped = `${v}.${iv}.${ct.slice(0, -2)}${ct.at(-2) === 'A' ? 'B' : 'A'}${ct.at(-1)}`;
  await assert.rejects(unseal(KEY, flipped, 'user1:gmail'));
  // Two seals of the same thing differ (fresh IV each time).
  assert.notEqual(await seal(KEY, tokens, 'user1:gmail'), sealed);
  // A missing or short key is refused.
  await assert.rejects(seal(undefined, tokens, 'x'), /32 random bytes/);
  await assert.rejects(seal(Buffer.from('short').toString('base64'), tokens, 'x'), /32 random bytes/);
});

// ----- OAuth ----------------------------------------------------------------------------

test('oauth: an app is set up only when both of its variables are', () => {
  assert.equal(oauth.oauthApp('gmail', {}), null);
  assert.equal(oauth.oauthApp('gmail', { AUTH_GOOGLE_ID: 'x', AUTH_GOOGLE_SECRET: 'y' }), null, 'sign-in client alone is not enough');
  assert.equal(oauth.oauthApp('gmail', { CONNECT_GOOGLE_ID: 'id' }), null);
  assert.deepEqual(oauth.oauthApp('gmail', { CONNECT_GOOGLE_ID: ' id ', CONNECT_GOOGLE_SECRET: 'sec\n' }), { clientId: 'id', clientSecret: 'sec' });
  assert.deepEqual(oauth.oauthApp('outlook', { CONNECT_MICROSOFT_ID: 'm', CONNECT_MICROSOFT_SECRET: 's' }), { clientId: 'm', clientSecret: 's' });
  assert.deepEqual(oauth.oauthApp('github', { CONNECT_GITHUB_ID: 'g', CONNECT_GITHUB_SECRET: 's' }), { clientId: 'g', clientSecret: 's' });
});

test('oauth: consent screen addresses carry what each service needs', async () => {
  const verifier = oauth.randomToken(48);
  assert.match(verifier, /^[\w-]{64}$/);
  const challenge = await oauth.pkceChallenge(verifier);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal(challenge, expected);

  const g = new URL(oauth.authorizeUrl('gmail', { clientId: 'cid', redirectUri: 'https://x.convex.site/connectors/gmail/callback', state: 'st', challenge }));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('client_id'), 'cid');
  assert.equal(g.searchParams.get('redirect_uri'), 'https://x.convex.site/connectors/gmail/callback');
  assert.equal(g.searchParams.get('response_type'), 'code');
  assert.equal(g.searchParams.get('state'), 'st');
  assert.equal(g.searchParams.get('code_challenge'), challenge);
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.equal(g.searchParams.get('prompt'), 'consent');
  assert.deepEqual(g.searchParams.get('scope').split(' '), ['openid', 'email', 'https://mail.google.com/'], 'Gmail\'s full access: read, send and delete');

  const o = new URL(oauth.authorizeUrl('outlook', { clientId: 'mid', redirectUri: 'https://x/cb', state: 's2', challenge }));
  assert.equal(o.origin + o.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.deepEqual(o.searchParams.get('scope').split(' '), ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send']);
  assert.equal(o.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(o.searchParams.get('response_mode'), 'query');

  const h = new URL(oauth.authorizeUrl('github', { clientId: 'gid', redirectUri: 'https://x/cb', state: 's3', challenge }));
  assert.equal(h.origin + h.pathname, 'https://github.com/login/oauth/authorize');
  assert.deepEqual(h.searchParams.get('scope').split(' '), ['repo', 'delete_repo', 'workflow', 'read:user']);
  assert.equal(h.searchParams.get('code_challenge'), null, 'GitHub OAuth apps get no PKCE');
});

test('oauth: trading a code, renewing, and turning down', async () => {
  const app = { clientId: 'cid', clientSecret: 'csecret' };
  const google = fakeFetch((req) => {
    const form = req.form();
    if (form.grant_type === 'authorization_code') {
      assert.equal(req.url, 'https://oauth2.googleapis.com/token');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(form, { grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'https://x/cb', client_id: 'cid', client_secret: 'csecret', code_verifier: 'ver' });
      return { json: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3599, scope: 'https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email', token_type: 'Bearer' } };
    }
    assert.deepEqual(form, { grant_type: 'refresh_token', refresh_token: 'rt1', client_id: 'cid', client_secret: 'csecret' });
    return { json: { access_token: 'at2', expires_in: 3599, token_type: 'Bearer' } };
  });
  const before = Date.now();
  const tokens = await oauth.exchangeCode('gmail', { app, code: 'the-code', redirectUri: 'https://x/cb', verifier: 'ver', fetch: google });
  assert.equal(tokens.accessToken, 'at1');
  assert.equal(tokens.refreshToken, 'rt1');
  assert.ok(tokens.expiresAt >= before + 3598_000 && tokens.expiresAt <= Date.now() + 3599_000);
  assert.deepEqual(oauth.missingScopes('gmail', tokens.scopes), []);
  const renewed = await oauth.refreshTokens('gmail', { app, tokens, fetch: google });
  assert.equal(renewed.accessToken, 'at2');
  assert.equal(renewed.refreshToken, 'rt1', 'Google keeps the refresh token');
  assert.deepEqual(renewed.scopes, tokens.scopes, 'scopes carry over when none come back');

  // Microsoft: the refresh names the scopes again and hands out a new refresh token.
  const microsoft = fakeFetch((req) => {
    const form = req.form();
    assert.equal(req.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(form.scope, form.refresh_token === 'mrt-old' ? 'Mail.Read Mail.Send User.Read offline_access' : 'offline_access User.Read Mail.ReadWrite Mail.Send');
    return { json: { access_token: 'mat', refresh_token: 'mrt2', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read' } };
  });
  const ms = await oauth.refreshTokens('outlook', { app, tokens: { accessToken: 'x', refreshToken: 'mrt1', scopes: [] }, fetch: microsoft });
  assert.equal(ms.refreshToken, 'mrt2');
  assert.deepEqual(oauth.missingScopes('outlook', ms.scopes), []);
  // A connection made before Holly Bot asked for more renews with what it was granted, so it keeps working.
  await oauth.refreshTokens('outlook', { app, tokens: { accessToken: 'x', refreshToken: 'mrt-old', scopes: ['Mail.Read', 'Mail.Send', 'User.Read'] }, fetch: microsoft });

  // GitHub answers a code with tokens that don't expire.
  const github = fakeFetch((req) => {
    assert.equal(req.url, 'https://github.com/login/oauth/access_token');
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.form().code_verifier, undefined);
    return { json: { access_token: 'gho_abc', scope: 'delete_repo,read:user,repo,workflow', token_type: 'bearer' } };
  });
  const ght = await oauth.exchangeCode('github', { app, code: 'c', redirectUri: 'https://x/cb', verifier: 'ignored', fetch: github });
  assert.deepEqual(ght, { accessToken: 'gho_abc', scopes: ['delete_repo', 'read:user', 'repo', 'workflow'] });
  assert.deepEqual(oauth.missingScopes('github', ght.scopes), []);

  // A turned-down code or refresh is an OAuthError with the service's code.
  const refused = fakeFetch(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
  await assert.rejects(oauth.refreshTokens('gmail', { app, tokens, fetch: refused }), (err) => err instanceof oauth.OAuthError && err.code === 'invalid_grant' && /expired or revoked/.test(err.message));
  // GitHub says no with HTTP 200 and an error field.
  const ghRefused = fakeFetch(() => ({ json: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } }));
  await assert.rejects(oauth.exchangeCode('github', { app, code: 'old', redirectUri: 'https://x/cb', fetch: ghRefused }), (err) => err.code === 'bad_verification_code');
  await assert.rejects(oauth.refreshTokens('github', { app, tokens: { accessToken: 'a', scopes: [] } }), (err) => err.code === 'invalid_grant');
});

test('oauth: unticked permissions are caught', () => {
  assert.deepEqual(oauth.missingScopes('gmail', ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']), ['https://mail.google.com/'], 'connected before deleting');
  assert.deepEqual(oauth.missingScopes('gmail', ['openid', 'email', 'https://mail.google.com/']), []);
  assert.deepEqual(oauth.missingScopes('outlook', ['User.Read', 'Mail.Read']), ['mail.readwrite', 'mail.send']);
  assert.deepEqual(oauth.missingScopes('outlook', ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send']), []);
  assert.deepEqual(oauth.missingScopes('github', ['read:user']), ['repo']);
  assert.deepEqual(oauth.missingScopes('gmail', []), [], 'a service that lists none is taken at its word');
});

test('oauth: revoking goes to Google and GitHub, and Microsoft has nothing to call', async () => {
  const f = fakeFetch(() => ({ status: 200, json: {} }));
  await oauth.revokeTokens('gmail', { app: null, tokens: { accessToken: 'at', refreshToken: 'rt/1', scopes: [] }, fetch: f });
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/revoke?token=rt%2F1');
  assert.equal(f.calls[0].method, 'POST');
  await oauth.revokeTokens('github', { app: { clientId: 'gid', clientSecret: 'gs' }, tokens: { accessToken: 'gho_x', scopes: [] }, fetch: f });
  const call = f.calls[1];
  assert.equal(call.url, 'https://api.github.com/applications/gid/token', 'just this token, not every grant');
  assert.equal(call.method, 'DELETE');
  assert.equal(call.headers.authorization, `Basic ${Buffer.from('gid:gs').toString('base64')}`);
  assert.deepEqual(call.json(), { access_token: 'gho_x' });
  await oauth.revokeTokens('outlook', { app: { clientId: 'm', clientSecret: 's' }, tokens: { accessToken: 'x', scopes: [] }, fetch: f });
  assert.equal(f.calls.length, 2);
});

// ----- Gmail ------------------------------------------------------------------------------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** The parts of a raw RFC 2822 message: headers and the decoded text. */
function parseMime(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, body, lines: head.split('\r\n') };
}

test('gmail: search lists the newest emails with their headers', async () => {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    assert.equal(req.headers.authorization, 'Bearer tok');
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('q'), 'from:anna is:unread');
      assert.equal(url.searchParams.get('maxResults'), '2');
      return { json: { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], resultSizeEstimate: 2 } };
    }
    assert.equal(url.searchParams.get('format'), 'metadata');
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Subject', 'Date']);
    const id = url.pathname.split('/').pop();
    return {
      json: {
        id,
        threadId: id === 'm1' ? 't1' : 't2',
        labelIds: id === 'm1' ? ['INBOX', 'UNREAD'] : ['INBOX'],
        snippet: 'Lunch &amp; a walk? It&#39;s sunny',
        payload: { headers: [{ name: 'From', value: 'Anna <anna@example.com>' }, { name: 'Subject', value: `Hi ${id}` }, { name: 'Date', value: 'Mon, 21 Sep 2026 09:00:00 +0000' }, { name: 'To', value: 'me@example.com' }] },
      },
    };
  });
  const list = await mail.gmailSearch({ token: 'tok', fetch: f }, { query: 'from:anna is:unread', max: 2 });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'm1', threadId: 't1', from: 'Anna <anna@example.com>', to: 'me@example.com', subject: 'Hi m1', date: 'Mon, 21 Sep 2026 09:00:00 +0000', snippet: "Lunch & a walk? It's sunny", unread: true });
  assert.equal(list[1].unread, false);
  // No query, no matches: nothing else is fetched.
  const empty = fakeFetch(() => ({ json: { resultSizeEstimate: 0 } }));
  assert.deepEqual(await mail.gmailSearch({ token: 'tok', fetch: empty }, { max: 500 }), []);
  assert.equal(new URL(empty.calls[0].url).searchParams.get('maxResults'), '25', 'at most 25 at a time');
  assert.equal(new URL(empty.calls[0].url).searchParams.get('q'), null);
});

test('gmail: reading prefers the plain text, falls back to HTML, lists attachments', async () => {
  const multipart = {
    id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'snip',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'Bob <bob@example.com>' }, { name: 'To', value: 'me@example.com' }, { name: 'Cc', value: 'c@example.com' }, { name: 'Subject', value: 'Report 📊' }, { name: 'Date', value: 'Tue' }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64url('Hello there — the report is attached. 📊') } },
          { mimeType: 'text/html', body: { data: b64url('<p>Hello <b>there</b></p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'a1', size: 52_000 } },
      ],
    },
  };
  const f = fakeFetch((req) => {
    assert.equal(new URL(req.url).searchParams.get('format'), 'full');
    return { json: multipart };
  });
  const m = await mail.gmailRead({ token: 't', fetch: f }, { id: 'm1' });
  assert.equal(m.body, 'Hello there — the report is attached. 📊');
  assert.equal(m.subject, 'Report 📊');
  assert.equal(m.cc, 'c@example.com');
  assert.deepEqual(m.attachments, [{ filename: 'report.pdf', mimeType: 'application/pdf', size: 52_000 }]);
  assert.equal(m.truncated, false);

  const htmlOnly = fakeFetch(() => ({ json: { id: 'm2', payload: { mimeType: 'text/html', headers: [], body: { data: b64url('<html><head><style>p{}</style></head><body><h1>News</h1><p>Read <a href="https://ex.com/a">the post</a>&nbsp;now.</p><ul><li>One</li><li>Two</li></ul><script>x()</script></body></html>') } } } }));
  const h = await mail.gmailRead({ token: 't', fetch: htmlOnly }, { id: 'm2' });
  assert.equal(h.body, 'News\nRead the post (https://ex.com/a) now.\n• One\n• Two');

  const huge = fakeFetch(() => ({ json: { id: 'm3', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x'.repeat(25_000)) } } } }));
  const big = await mail.gmailRead({ token: 't', fetch: huge }, { id: 'm3' });
  assert.equal(big.truncated, true);
  assert.match(big.body, /\[…cut: 5000 more characters\]$/);
  await assert.rejects(mail.gmailRead({ token: 't', fetch: huge }, { id: ' ' }), /Which email/);
});

test('gmail: sending builds a clean UTF-8 message, and headers can\'t be slipped in', async () => {
  const f = fakeFetch((req) => {
    assert.equal(req.url, `${GMAIL}/messages/send`);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    return { json: { id: 'sent1', threadId: 'thr1', labelIds: ['SENT'] } };
  });
  const out = await mail.gmailSend({ token: 't', fetch: f }, {
    to: 'Anna Li <anna@example.com>, bob@example.com',
    cc: ['carol@example.com'],
    subject: 'Plans for Friday 🎉\r\nBcc: spy@evil.example',
    body: 'Hi Anna,\n\nSee you at 7 — café on Main St.\n\nChris',
  });
  assert.equal(out.sent, true);
  assert.equal(out.id, 'sent1');
  assert.deepEqual(out.to, ['Anna Li <anna@example.com>', 'bob@example.com']);
  const payload = f.calls[0].json();
  assert.deepEqual(Object.keys(payload), ['raw']);
  const raw = Buffer.from(payload.raw, 'base64url').toString('utf8');
  const msg = parseMime(raw);
  assert.equal(msg.headers.to, 'Anna Li <anna@example.com>, bob@example.com');
  assert.equal(msg.headers.cc, 'carol@example.com');
  assert.equal(msg.headers.bcc, undefined, 'no Bcc slipped in through the subject');
  assert.ok(!msg.lines.some((l) => /^bcc:/i.test(l)));
  const subject = msg.headers.subject.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  assert.ok(subject, 'a non-ASCII subject is MIME-encoded');
  assert.equal(Buffer.from(subject[1], 'base64').toString('utf8'), 'Plans for Friday 🎉 Bcc: spy@evil.example');
  assert.equal(msg.headers['content-type'], 'text/plain; charset="UTF-8"');
  assert.equal(msg.headers['content-transfer-encoding'], 'base64');
  assert.equal(msg.body, 'Hi Anna,\n\nSee you at 7 — café on Main St.\n\nChris');
  assert.ok(raw.split('\r\n').every((line) => line.length <= 998), 'no over-long lines');

  await assert.rejects(mail.gmailSend({ token: 't', fetch: f }, { to: 'not an address', body: 'x' }), /isn't an email address/);
  await assert.rejects(mail.gmailSend({ token: 't', fetch: f }, { to: 'a@b.co', body: '  ' }), /no text/);
  await assert.rejects(mail.gmailSend({ token: 't', fetch: f }, { body: 'hi' }), /Who is the email to/);
  await assert.rejects(mail.gmailSend({ token: 't', fetch: f }, { to: 'a@b.co\r\nBcc: x@y.z', body: 'hi' }), /isn't an email address/);
  assert.equal(f.calls.length, 1, 'nothing else was sent');
});

test('gmail: a reply stays in its thread, answers the sender and quotes the right ids', async () => {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      assert.equal(url.pathname, '/gmail/v1/users/me/messages/orig1');
      assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['Message-ID', 'References', 'Subject', 'From', 'Reply-To']);
      return { json: { id: 'orig1', threadId: 'thread9', payload: { headers: [
        { name: 'Message-ID', value: '<abc@mail.example.com>' },
        { name: 'References', value: '<older@mail.example.com>' },
        { name: 'Subject', value: 'Dinner?' },
        { name: 'From', value: 'Dana <dana@example.com>' },
      ] } } };
    }
    return { json: { id: 'r1', threadId: 'thread9' } };
  });
  const out = await mail.gmailSend({ token: 't', fetch: f }, { replyTo: 'orig1', body: 'Yes, 8pm works.' });
  assert.equal(out.threadId, 'thread9');
  assert.equal(out.subject, 'Re: Dinner?');
  assert.deepEqual(out.to, ['Dana <dana@example.com>']);
  const payload = f.calls[1].json();
  assert.equal(payload.threadId, 'thread9');
  const msg = parseMime(Buffer.from(payload.raw, 'base64url').toString('utf8'));
  assert.equal(msg.headers['in-reply-to'], '<abc@mail.example.com>');
  assert.equal(msg.headers.references, '<older@mail.example.com> <abc@mail.example.com>');
  assert.equal(msg.headers.subject, 'Re: Dinner?');
  assert.equal(msg.headers.to, 'Dana <dana@example.com>');
  assert.equal(msg.body, 'Yes, 8pm works.');
});

test('gmail: service errors keep their status and message', async () => {
  const f = fakeFetch(() => ({ status: 401, json: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } }));
  await assert.rejects(mail.gmailProfile({ token: 'old', fetch: f }), (err) => err instanceof mail.ApiError && err.status === 401 && /invalid authentication/.test(err.message));
  const g = fakeFetch(() => ({ json: { emailAddress: 'me@gmail.com', messagesTotal: 10 } }));
  assert.deepEqual(await mail.gmailProfile({ token: 't', fetch: g }), { email: 'me@gmail.com' });
  assert.equal(g.calls[0].url, `${GMAIL}/profile`);
});

// ----- Outlook (Microsoft Graph) ------------------------------------------------------------

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const graphMessage = (id, extra = {}) => ({
  id, conversationId: `c-${id}`, subject: `Subject ${id}`, receivedDateTime: '2026-09-20T10:00:00Z', bodyPreview: 'Preview', isRead: false,
  from: { emailAddress: { name: 'Eve', address: 'eve@contoso.com' } },
  toRecipients: [{ emailAddress: { name: 'Me', address: 'me@outlook.com' } }],
  ...extra,
});

test('outlook: search with words, or the newest in the inbox', async () => {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    assert.equal(req.headers.authorization, 'Bearer tok');
    if (url.searchParams.has('$search')) {
      assert.equal(url.pathname, '/v1.0/me/messages');
      assert.equal(url.searchParams.get('$search'), '"from:eve invoice"');
      assert.equal(url.searchParams.get('$orderby'), null, 'Graph refuses $orderby with $search');
    } else {
      assert.equal(url.pathname, '/v1.0/me/mailFolders/inbox/messages');
      assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime desc');
    }
    assert.equal(url.searchParams.get('$top'), '5');
    return { json: { value: [graphMessage('a'), graphMessage('b', { isRead: true, from: { emailAddress: { address: 'x@y.z' } } })] } };
  });
  const found = await mail.outlookSearch({ token: 'tok', fetch: f }, { query: 'from:eve "invoice"', max: 5 });
  assert.deepEqual(found[0], { id: 'a', threadId: 'c-a', from: 'Eve <eve@contoso.com>', to: 'Me <me@outlook.com>', subject: 'Subject a', date: '2026-09-20T10:00:00Z', snippet: 'Preview', unread: true });
  assert.equal(found[1].from, 'x@y.z');
  assert.equal(found[1].unread, false);
  await mail.outlookSearch({ token: 'tok', fetch: f }, { max: 5 });
  assert.equal(f.calls.length, 2);
});

test('outlook: reading asks for plain text and lists attachments', async () => {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/attachments')) return { json: { value: [{ name: 'q3.xlsx', contentType: 'application/vnd.ms-excel', size: 2048 }] } };
    assert.equal(req.headers.prefer, 'outlook.body-content-type="text"');
    return { json: graphMessage('m/1+x', { hasAttachments: true, ccRecipients: [{ emailAddress: { address: 'cc@contoso.com' } }], body: { contentType: 'text', content: 'Numbers attached.\r\n' } }) };
  });
  const m = await mail.outlookRead({ token: 't', fetch: f }, { id: 'm/1+x' });
  assert.equal(new URL(f.calls[0].url).pathname, '/v1.0/me/messages/m%2F1%2Bx', 'ids are escaped');
  assert.equal(m.body, 'Numbers attached.');
  assert.equal(m.cc, 'cc@contoso.com');
  assert.deepEqual(m.attachments, [{ filename: 'q3.xlsx', mimeType: 'application/vnd.ms-excel', size: 2048 }]);
  // HTML despite the preference still comes back readable.
  const html = fakeFetch(() => ({ json: graphMessage('h', { body: { contentType: 'html', content: '<div>Hi<br>there</div>' } }) }));
  assert.equal((await mail.outlookRead({ token: 't', fetch: html }, { id: 'h' })).body, 'Hi\nthere');
});

test('outlook: sending a new email and replying', async () => {
  const f = fakeFetch(() => ({ status: 202, text: '' }));
  const out = await mail.outlookSend({ token: 't', fetch: f }, { to: ['"Li, Anna" <anna@contoso.com>'], bcc: 'b@contoso.com', subject: 'Hello\nX-Evil: 1', body: 'Hi Anna 👋' });
  assert.equal(out.sent, true);
  assert.equal(f.calls[0].url, `${GRAPH}/sendMail`);
  assert.deepEqual(f.calls[0].json(), {
    message: {
      subject: 'Hello X-Evil: 1',
      body: { contentType: 'Text', content: 'Hi Anna 👋' },
      toRecipients: [{ emailAddress: { name: 'Li, Anna', address: 'anna@contoso.com' } }],
      bccRecipients: [{ emailAddress: { address: 'b@contoso.com' } }],
    },
    saveToSentItems: true,
  });
  await mail.outlookSend({ token: 't', fetch: f }, { replyTo: 'orig-1', body: 'Thanks!' });
  assert.equal(f.calls[1].url, `${GRAPH}/messages/orig-1/reply`);
  assert.deepEqual(f.calls[1].json(), { comment: 'Thanks!' });
  await mail.outlookSend({ token: 't', fetch: f }, { replyTo: 'orig-1', to: 'z@contoso.com', body: 'Looping in Z' });
  assert.deepEqual(f.calls[2].json(), { comment: 'Looping in Z', message: { toRecipients: [{ emailAddress: { address: 'z@contoso.com' } }] } });
  const who = fakeFetch(() => ({ json: { displayName: 'Me', mail: null, userPrincipalName: 'me@outlook.com' } }));
  assert.deepEqual(await mail.outlookProfile({ token: 't', fetch: who }), { email: 'me@outlook.com' });
  const denied = fakeFetch(() => ({ status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }));
  await assert.rejects(mail.outlookSend({ token: 't', fetch: denied }, { to: 'a@b.co', body: 'x' }), (err) => err.status === 403 && err.message === 'Access is denied.');
});

// ----- deleting email -------------------------------------------------------------------------

/** A Gmail mailbox that trashes, restores and deletes for good like the real one. */
function gmailBox(mail) {
  const trashed = new Set();
  const gone = new Set();
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    const live = (id) => mail[id] && !gone.has(id);
    if (path === '/messages' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const withTrash = url.searchParams.get('includeSpamTrash') === 'true';
      const all = Object.keys(mail).filter((id) => live(id) && (withTrash || !trashed.has(id))
        && (q === 'in:trash' ? trashed.has(id) : mail[id].from.toLowerCase().includes(q.replace('from:', '').toLowerCase())));
      const start = Number(url.searchParams.get('pageToken') || 0);
      const size = Math.min(Number(url.searchParams.get('maxResults')), 2); // two a page, to exercise paging
      const page = all.slice(start, start + size);
      return { json: { messages: page.map((id) => ({ id, threadId: `t-${id}` })), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) } };
    }
    if (path === '/messages/batchDelete') {
      for (const id of req.json().ids) gone.add(id);
      return { status: 204 };
    }
    const m = path.match(/^\/messages\/([^/]+)(?:\/(trash|untrash))?$/);
    const id = m && decodeURIComponent(m[1]);
    if (!id || !live(id)) return { status: 404, json: { error: { code: 404, message: 'Requested entity was not found.' } } };
    if (m[2] === 'trash') trashed.add(id);
    if (m[2] === 'untrash') trashed.delete(id);
    return { json: { id, labelIds: trashed.has(id) ? ['TRASH'] : ['INBOX'], payload: { headers: [{ name: 'From', value: mail[id].from }, { name: 'Subject', value: mail[id].subject }, { name: 'Date', value: mail[id].date }] } } };
  });
  return { f, trashed, gone };
}

test('gmail: a delete reaches exactly the emails meant, to Trash or for good, and comes back', async () => {
  const { f, trashed, gone } = gmailBox({
    g1: { from: 'Groupon <deals@groupon.com>', subject: 'Deals for you', date: 'Mon, 21 Sep 2026 09:00:00 +0000' },
    g2: { from: 'Groupon <deals@groupon.com>', subject: 'Last chance', date: 'Sun, 20 Sep 2026 09:00:00 +0000' },
    g3: { from: '"Groupon" <deals@groupon.com>', subject: 'Weekend', date: 'Sat, 19 Sep 2026 09:00:00 +0000' },
    a1: { from: 'Anna <anna@example.com>', subject: 'Dinner?', date: 'Sat, 19 Sep 2026 10:00:00 +0000' },
  });
  const api = { token: 't', fetch: f };
  // The preview: every match (across pages), the first ones by sender and subject.
  const p = await mail.gmailPeek(api, { query: 'from:groupon', max: 50 });
  assert.equal(p.total, 3);
  assert.deepEqual(p.ids, ['g1', 'g2', 'g3']);
  assert.deepEqual(p.named[0], { id: 'g1', from: 'Groupon', subject: 'Deals for you', date: 'Mon, 21 Sep 2026 09:00:00 +0000' });
  assert.equal(p.named[2].from, 'Groupon', 'the sender\'s name, quoted or not');
  assert.equal((await mail.gmailPeek(api, { query: 'from:groupon', max: 2 })).total, 2, 'no more than max');
  await assert.rejects(mail.gmailPeek(api, {}), /Which emails/, 'nothing named, nothing deleted');

  // To Trash, by the ids the preview found; Anna's email is untouched.
  const r = await mail.gmailDelete(api, { ids: p.ids });
  assert.deepEqual(r, { deleted: 3, forever: false, ids: ['g1', 'g2', 'g3'], failed: [] });
  assert.deepEqual([...trashed].sort(), ['g1', 'g2', 'g3']);
  assert.ok(f.calls.filter((c) => c.url.endsWith('/trash')).every((c) => c.method === 'POST'));
  // Back out of Trash.
  assert.deepEqual(await mail.gmailRestore(api, { ids: ['g2'] }), { restored: 1, ids: ['g2'], failed: [] });
  assert.ok(!trashed.has('g2'));
  // Emptying the trash, for good: Trash is searched only when asked for by name, in one batch.
  const forever = await mail.gmailDelete(api, { query: 'in:trash', forever: true });
  assert.deepEqual(forever, { deleted: 2, forever: true, ids: ['g1', 'g3'], failed: [] });
  assert.equal(new URL(f.calls.find((c) => /q=in%3Atrash/.test(c.url)).url).searchParams.get('includeSpamTrash'), 'true');
  const batch = f.calls.find((c) => c.url.endsWith('/batchDelete'));
  assert.deepEqual(batch.json(), { ids: ['g1', 'g3'] });
  assert.deepEqual([...gone].sort(), ['g1', 'g3']);
  assert.ok(!f.calls.some((c) => /q=from%3Agroupon/.test(c.url) && c.url.includes('includeSpamTrash')), 'other searches leave Trash out');

  // Some found, some not: what worked, and what didn't.
  const partly = await mail.gmailDelete(api, { ids: 'a1, nope' });
  assert.equal(partly.deleted, 1);
  assert.deepEqual(partly.failed.map((x) => x.id), ['nope']);
  // None worked (an expired token): the error itself, so the token is renewed and the whole thing retried.
  const expired = fakeFetch(() => ({ status: 401, json: { error: { message: 'Invalid Credentials' } } }));
  await assert.rejects(mail.gmailDelete({ token: 'old', fetch: expired }, { ids: ['g2'] }), (err) => err instanceof mail.ApiError && err.status === 401);
  // A search can't reach more than 500 at once.
  const counting = fakeFetch(() => ({ json: { messages: [] } }));
  await mail.gmailPeek({ token: 't', fetch: counting }, { query: 'older_than:1y', max: 5000 });
  assert.equal(new URL(counting.calls[0].url).searchParams.get('maxResults'), '500');
});

/** An Outlook mailbox: folders, search, moving (which gives an email a new id) and deleting for good. */
function outlookBox(mail) {
  let seq = 0;
  let inFlight = 0;
  let most = 0;
  const f = fakeFetch(async (req) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const url = new URL(req.url);
    const path = url.pathname.replace('/v1.0/me', '');
    const row = (id) => ({ id, subject: mail[id].subject, from: { emailAddress: { name: mail[id].name, address: mail[id].address } }, receivedDateTime: mail[id].date });
    const list = (ids) => {
      const top = Number(url.searchParams.get('$top'));
      const skip = Number(url.searchParams.get('$skip') || 0);
      const page = ids.slice(skip, skip + Math.min(top, 2));
      const next = new URL(req.url);
      next.searchParams.set('$skip', String(skip + 2));
      return { json: { value: page.map(row), ...(skip + 2 < ids.length ? { '@odata.nextLink': next.toString() } : {}) } };
    };
    const folderOf = path.match(/^\/mailFolders\/([^/]+)\/messages$/)?.[1];
    if (path === '/messages' || folderOf) {
      const q = (url.searchParams.get('$search') || '').replace(/"/g, '').toLowerCase();
      return list(Object.keys(mail).filter((id) => (!folderOf || mail[id].folder === folderOf) && (!q || mail[id].name.toLowerCase().includes(q))));
    }
    const m = path.match(/^\/messages\/([^/]+)(?:\/(move|permanentDelete))?$/);
    const id = m && decodeURIComponent(m[1]);
    if (!id || !mail[id]) return { status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } };
    if (m[2] === 'permanentDelete') {
      delete mail[id];
      return { status: 204 };
    }
    if (m[2] === 'move') {
      const moved = { ...mail[id], folder: req.json().destinationId };
      delete mail[id];
      const newId = `${id.split('~')[0]}~${++seq}`;
      mail[newId] = moved;
      return { status: 201, json: { id: newId, ...row(newId) } };
    }
    return { json: row(id) };
  });
  return { f, most: () => most };
}

test('outlook: a delete reaches exactly the emails meant, to Deleted Items or for good, and comes back', async () => {
  const mailbox = {
    s1: { name: 'Shop', address: 'news@shop.example', subject: 'Sale', date: '2026-09-21T09:00:00Z', folder: 'inbox' },
    s2: { name: 'Shop', address: 'news@shop.example', subject: 'Sale ends', date: '2026-09-20T09:00:00Z', folder: 'inbox' },
    s3: { name: 'Shop', address: 'news@shop.example', subject: 'New in', date: '2026-09-19T09:00:00Z', folder: 'inbox' },
    b1: { name: 'Boss', address: 'boss@contoso.com', subject: 'Q3', date: '2026-09-18T09:00:00Z', folder: 'inbox' },
  };
  const { f, most } = outlookBox(mailbox);
  const api = { token: 't', fetch: f };
  const p = await mail.outlookPeek(api, { query: 'shop', max: 50 });
  assert.equal(p.total, 3, 'across pages');
  assert.deepEqual(p.named[0], { id: 's1', from: 'Shop', subject: 'Sale', date: '2026-09-21T09:00:00Z' });
  assert.equal(new URL(f.calls[0].url).searchParams.get('$search'), '"shop"');

  // To Deleted Items: each email gets a new id there, and those are what restoring takes.
  const r = await mail.outlookDelete(api, { ids: p.ids });
  assert.equal(r.deleted, 3);
  assert.equal(r.forever, false);
  assert.ok(r.ids.every((id) => mailbox[id]?.folder === 'deleteditems'));
  const moves = f.calls.filter((c) => c.url.endsWith('/move'));
  assert.ok(moves.every((c) => c.method === 'POST' && c.json().destinationId === 'deleteditems'));
  assert.ok(most() <= 4, 'no more than 4 calls at once (Outlook\'s limit per mailbox)');
  const back = await mail.outlookRestore(api, { ids: [r.ids[0]] });
  assert.equal(back.restored, 1);
  assert.equal(mailbox[back.ids[0]].folder, 'inbox');

  // Emptying Deleted Items for good, by folder; the boss's email stays.
  const gone = await mail.outlookDelete(api, { folder: 'deleteditems', forever: true });
  assert.equal(gone.deleted, 2);
  assert.ok(f.calls.some((c) => new URL(c.url).pathname === '/v1.0/me/mailFolders/deleteditems/messages'));
  assert.ok(f.calls.filter((c) => c.url.endsWith('/permanentDelete')).every((c) => c.method === 'POST'));
  assert.deepEqual(Object.values(mailbox).map((m) => m.subject).sort(), ['Q3', 'Sale']);

  // Names people use for folders, and ones Outlook doesn't have.
  await mail.outlookSearch(api, { folder: 'Trash' });
  assert.equal(new URL(f.calls.at(-1).url).pathname, '/v1.0/me/mailFolders/deleteditems/messages');
  await assert.rejects(mail.outlookPeek(api, { folder: 'secret' }), /no folder “secret”/);
  await assert.rejects(mail.outlookPeek(api, {}), /Which emails/);
  // Named by id: looked up for the preview.
  const byId = await mail.outlookPeek(api, { ids: ['b1'] });
  assert.deepEqual(byId.named, [{ id: 'b1', from: 'Boss', subject: 'Q3', date: '2026-09-18T09:00:00Z' }]);
  // A next page on another host isn't followed.
  const foreign = fakeFetch(() => ({ json: { value: [{ id: 'x1', subject: 's', from: {} }], '@odata.nextLink': 'https://evil.example/next' } }));
  assert.equal((await mail.outlookPeek({ token: 't', fetch: foreign }, { query: 'x', max: 50 })).total, 1);
  assert.equal(foreign.calls.length, 1);
});

// ----- GitHub --------------------------------------------------------------------------------

const API = 'https://api.github.com';
const repoJson = (full, extra = {}) => ({ full_name: full, private: true, description: null, default_branch: 'main', html_url: `https://github.com/${full}`, pushed_at: '2026-09-01T00:00:00Z', archived: false, ...extra });

test('github: every call names itself, its API version and the token', async () => {
  const f = fakeFetch(() => ({ json: { login: 'octo', name: 'Octo Cat' }, headers: { 'x-oauth-scopes': 'repo, delete_repo, workflow' } }));
  assert.deepEqual(await gh.githubUser({ token: 'ghp_x', fetch: f }), { login: 'octo', name: 'Octo Cat', scopes: ['repo', 'delete_repo', 'workflow'] });
  const { headers, url } = f.calls[0];
  assert.equal(url, `${API}/user`);
  assert.equal(headers.authorization, 'Bearer ghp_x');
  assert.equal(headers['user-agent'], 'Holly-Bot');
  assert.equal(headers['x-github-api-version'], '2022-11-28');
  assert.equal(headers.accept, 'application/vnd.github+json');
});

test('github: listing, creating, changing and deleting repositories', async () => {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    if (key === 'GET /user/repos') {
      assert.equal(url.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
      assert.equal(url.searchParams.get('sort'), 'updated');
      return { json: [repoJson('octo/app'), repoJson('octo/site', { private: false, description: 'My site' })] };
    }
    if (key === 'GET /users/torvalds/repos') return { json: [repoJson('torvalds/linux', { private: false })] };
    if (key === 'POST /user/repos') return { status: 201, json: repoJson(`octo/${req.json().name}`, { private: req.json().private }) };
    if (key === 'POST /orgs/acme/repos') return { status: 201, json: repoJson(`acme/${req.json().name}`) };
    if (key === 'PATCH /repos/octo/app') return { json: repoJson('octo/app2', { private: false }) };
    if (key === 'DELETE /repos/octo/app2') return { status: 204 };
    return { status: 404, json: { message: 'Not Found' } };
  });
  const api = { token: 't', fetch: f };
  const mine = await gh.listRepos(api, {});
  assert.deepEqual(mine.map((r) => r.repo), ['octo/app', 'octo/site']);
  assert.deepEqual(mine[1], { repo: 'octo/site', private: false, description: 'My site', defaultBranch: 'main', url: 'https://github.com/octo/site', updated: '2026-09-01T00:00:00Z', archived: false });
  assert.equal((await gh.listRepos(api, { owner: 'torvalds', max: 5 }))[0].repo, 'torvalds/linux');
  assert.equal(new URL(f.calls[1].url).searchParams.get('per_page'), '5');

  const created = await gh.createRepo(api, { name: 'notes', description: 'Bot notes' });
  assert.equal(created.repo, 'octo/notes');
  assert.deepEqual(f.calls[2].json(), { name: 'notes', description: 'Bot notes', private: true, auto_init: true }, 'private with a README unless asked otherwise');
  await gh.createRepo(api, { name: 'open', private: false, autoInit: false });
  assert.deepEqual(f.calls[3].json(), { name: 'open', description: '', private: false, auto_init: false });
  assert.equal((await gh.createRepo(api, { name: 'tools', org: 'acme' })).repo, 'acme/tools');
  await assert.rejects(gh.createRepo(api, { name: 'bad name!' }), /letters, numbers/);

  const changed = await gh.updateRepo(api, { repo: 'https://github.com/octo/app.git', name: 'app2', private: false, defaultBranch: 'dev' });
  assert.equal(changed.repo, 'octo/app2');
  assert.deepEqual(f.calls[5].json(), { name: 'app2', private: false, default_branch: 'dev' });
  await assert.rejects(gh.updateRepo(api, { repo: 'octo/app' }), /Nothing to change/);

  assert.deepEqual(await gh.deleteRepo(api, { repo: 'octo/app2' }), { deleted: true, repo: 'octo/app2' });
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).body, undefined);
  await assert.rejects(gh.deleteRepo(api, { repo: '../../user' }), /isn't a repository/);
  await assert.rejects(gh.deleteRepo(api, { repo: 'octo/missing' }), (err) => err instanceof gh.GitHubError && err.status === 404 && err.message === 'Not Found');
});

test('github: listing, reading, writing and deleting files', async () => {
  const files = new Map([['README.md', { text: '# Hello\n', sha: 'sha-readme' }], ['logo.png', { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), sha: 'sha-logo' }]]);
  let commits = 0;
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/repos\/octo\/app\/contents(?:\/(.*))?$/);
    if (!m) return { status: 404, json: { message: 'Not Found' } };
    const path = decodeURIComponent(m[1] || '');
    if (req.method === 'GET') {
      if (!path || path === 'docs') {
        return { json: [...files.keys()].filter((p) => (path ? p.startsWith(`${path}/`) : true)).map((p) => ({ path: p, type: 'file', size: 10 })).concat(path ? [] : [{ path: 'docs', type: 'dir', size: 0 }]) };
      }
      const file = files.get(path);
      if (!file) return { status: 404, json: { message: 'Not Found' } };
      const content = (file.bytes || Buffer.from(file.text, 'utf8')).toString('base64').replace(/(.{60})/g, '$1\n');
      return { json: { type: 'file', path, sha: file.sha, size: 10, encoding: 'base64', content, html_url: `https://github.com/octo/app/blob/main/${path}` } };
    }
    const body = req.json();
    if (req.method === 'PUT') {
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha) return { status: 409, json: { message: `${path} does not match ${body.sha}` } };
      if (!existing && body.sha) return { status: 422, json: { message: 'sha wasn\'t supplied' } };
      files.set(path, { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha-${++commits}`, branch: body.branch, message: body.message });
      return { status: existing ? 200 : 201, json: { content: { path, html_url: `https://github.com/octo/app/blob/main/${path}` }, commit: { sha: `commit${commits}abcdef` } } };
    }
    if (req.method === 'DELETE') {
      assert.equal(body.sha, files.get(path)?.sha);
      files.delete(path);
      return { json: { content: null, commit: { sha: 'commitdel123' } } };
    }
    return { status: 405, json: { message: 'no' } };
  });
  const api = { token: 't', fetch: f };
  const top = await gh.listFiles(api, { repo: 'octo/app' });
  assert.equal(f.calls[0].url, `${API}/repos/octo/app/contents`, 'the top folder has no trailing slash');
  assert.deepEqual(top.map((x) => x.path), ['README.md', 'logo.png', 'docs']);

  const readme = await gh.readFile(api, { repo: 'octo/app', path: '/README.md' });
  assert.equal(readme.text, '# Hello\n');
  assert.equal(readme.binary, false);
  const logo = await gh.readFile(api, { repo: 'octo/app', path: 'logo.png' });
  assert.equal(logo.binary, true);
  assert.equal(logo.text, '');
  await assert.rejects(gh.readFile(api, { repo: 'octo/app', path: 'docs' }), /is a folder/);
  await assert.rejects(gh.readFile(api, { repo: 'octo/app', path: '../secrets' }), /can't go up/);

  const updated = await gh.writeFile(api, { repo: 'octo/app', path: 'README.md', content: '# Hello, world ✨\n' });
  assert.equal(updated.created, false);
  assert.equal(files.get('README.md').text, '# Hello, world ✨\n');
  assert.equal(files.get('README.md').message, 'Update README.md');
  const created = await gh.writeFile(api, { repo: 'octo/app', path: 'docs/new page.md', content: 'hi', message: 'Add a page', branch: 'dev' });
  assert.equal(created.created, true);
  assert.equal(created.path, 'docs/new page.md');
  assert.ok(f.calls.some((c) => c.method === 'PUT' && c.url === `${API}/repos/octo/app/contents/docs/new%20page.md`), 'each part of the path is escaped');
  assert.equal(files.get('docs/new page.md').branch, 'dev');
  assert.equal(files.get('docs/new page.md').message, 'Add a page');
  assert.equal(new URL(f.calls.filter((c) => c.method === 'GET').at(-1).url).searchParams.get('ref'), 'dev', 'the sha is looked up on that branch');

  const removed = await gh.deleteFile(api, { repo: 'octo/app', path: 'README.md' });
  assert.deepEqual(removed, { repo: 'octo/app', path: 'README.md', deleted: true, commit: 'commitdel123' });
  assert.ok(!files.has('README.md'));
  await assert.rejects(gh.deleteFile(api, { repo: 'octo/app', path: 'README.md' }), /isn't in octo\/app/);
});

test('github: any other API call, safely', async () => {
  const f = fakeFetch((req) => {
    if (req.method === 'GET') return { json: [{ number: 1, title: 'Bug' }] };
    if (req.method === 'DELETE') return { status: 204 };
    return { status: 201, json: { number: 2, title: req.json().title ?? '' } };
  });
  const api = { token: 't', fetch: f };
  const list = await gh.request(api, { method: 'get', path: 'https://api.github.com/repos/octo/app/issues?state=open' });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body), [{ number: 1, title: 'Bug' }]);
  assert.equal(f.calls[0].url, `${API}/repos/octo/app/issues?state=open`);
  assert.equal(f.calls[0].body, undefined, 'GET carries no body');
  const made = await gh.request(api, { method: 'POST', path: '/repos/octo/app/issues', body: '{"title":"New"}' });
  assert.equal(made.status, 201);
  assert.deepEqual(f.calls[1].json(), { title: 'New' });
  await gh.request(api, { method: 'POST', path: '/repos/octo/app/forks' });
  assert.deepEqual(f.calls[2].json(), {}, 'a POST without a body sends {}');
  await gh.request(api, { method: 'DELETE', path: '/user/starred/octo/app' });
  assert.equal(f.calls[3].body, undefined, 'a DELETE without a body sends none');
  for (const path of ['repos/x', '/repos/../user', '/repos/x y', '/repos/x#frag']) {
    await assert.rejects(gh.request(api, { method: 'GET', path }), /API path/);
  }
  await assert.rejects(gh.request(api, { method: 'TRACE', path: '/user' }), /isn't a GitHub API method/);
  // Repositories are deleted only through deleteRepo, which the app always asks about.
  for (const path of ['/repos/octo/app', '/repos/octo/app/', '/repos/octo/app?x=1']) {
    await assert.rejects(gh.request(api, { method: 'DELETE', path }), /delete_repo/);
  }
  await gh.request(api, { method: 'DELETE', path: '/repos/octo/app/git/refs/heads/old' });
  await assert.rejects(gh.request(api, { method: 'POST', path: '/x', body: '{bad' }), /must be JSON/);
  // Whatever the path, the call goes to api.github.com.
  await gh.request(api, { method: 'GET', path: '//evil.example/x' });
  assert.equal(new URL(f.calls.at(-1).url).host, 'api.github.com');
  const long = fakeFetch(() => ({ json: { text: 'y'.repeat(40_000) } }));
  assert.match((await gh.request({ token: 't', fetch: long }, { path: '/x' })).body, /…\[cut: \d+ more characters\]$/);
});

// ----- GitHub for real (read-only, Holly Bot's own public repository) -------------------

test('github live: a public repository, its folders and files, read from api.github.com', { timeout: 30_000 }, async (t) => {
  const repo = 'xgamer791/holly-bot';
  let info;
  try {
    info = await gh.request({}, { method: 'GET', path: `/repos/${repo}` });
  } catch (err) {
    if (err instanceof gh.GitHubError && (err.status === 403 || err.status === 429)) return t.skip(`GitHub rate limit: ${err.message}`);
    if (!(err instanceof gh.GitHubError)) return t.skip(`GitHub unreachable here: ${err.message}`);
    throw err;
  }
  assert.equal(info.status, 200);
  assert.equal(JSON.parse(info.body).full_name, repo);
  const top = await gh.listFiles({}, { repo });
  assert.ok(top.some((f) => f.path === 'index.html' && f.type === 'file'), 'index.html at the top');
  assert.ok(top.some((f) => f.path === 'convex' && f.type === 'dir'), 'the convex folder');
  const inner = await gh.listFiles({}, { repo, path: 'convex/lib' });
  assert.ok(inner.every((f) => f.path.startsWith('convex/lib/')));
  const manifest = await gh.readFile({}, { repo, path: 'manifest.webmanifest' });
  assert.equal(manifest.binary, false);
  assert.match(JSON.parse(manifest.text).name, /Holly/);
  const icon = await gh.readFile({}, { repo, path: 'icons/icon-192.png' }).catch((err) => err);
  if (!(icon instanceof Error)) assert.equal(icon.binary, true, 'a PNG is not read as text');
  await assert.rejects(gh.readFile({}, { repo, path: 'no/such/file.txt' }), (err) => err.status === 404);
});
