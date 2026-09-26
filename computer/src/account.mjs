// Holly Bot Computer's own session on the Holly Bot account it keeps its bots in.
// The app links it (convex/devices.ts): it makes a one-time code, and the
// computer trades the code for a session of its own, separate from the
// phone's, kept in <data>/account.json (readable only by you). The protocol is
// the app's (src/account/account.js): a one-hour JWT, renewed with a refresh
// token that changes each time. The session lasts a year and is renewed well
// before; unlinking, from here or from the app, or deleting the account ends it.
//
// The same file keeps the access key the account's devices reach this
// computer with (computer/src/home.mjs tells the account). It's made when the
// computer is linked and goes when it's unlinked, so a device that got it from
// the account can't reach the computer after that.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { ConvexHttpClient } from '../../vendor/convex.js';
import { CONVEX_URL } from '../../src/account/config.js';
import { makeLinkCode } from '../../src/account/device-link.js';

/** A link this old renews itself (sessions last a year). */
const RENEW_AFTER = 300 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function claims(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const userIdOf = (jwt) => (jwt && claims(jwt)?.sub?.split('|')[0]) || null;

function msLeft(jwt) {
  const exp = claims(jwt)?.exp;
  return exp ? exp * 1000 - Date.now() : 0;
}

const isAuthError = (err) => /unauthenticated|invalidauthheader|oidc|expired|not signed in/i.test(err?.message || '');

const newAccessKey = () => randomBytes(32).toString('base64url');

export class AccountLink {
  constructor(file, { url = CONVEX_URL, name = 'Holly Bot Computer', log = console } = {}) {
    this.file = file;
    this.url = url;
    this.name = name;
    this.log = log;
    this.state = null;
    this.refreshing = null;
    /** Called when the server ends the link (unlinked from the app, account deleted). */
    this.onEnded = () => {};
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.url === url && saved.refreshToken && saved.userId) this.state = saved;
    } catch { /* not linked */ }
  }

  get linked() {
    return !!this.state;
  }

  get userId() {
    return this.state?.userId ?? null;
  }

  /** The key the account's devices reach this computer with, besides the
   * pairing token (computer/src/server.mjs), or null while it isn't linked. */
  get accessKey() {
    return this.state?.access ?? null;
  }

  /** Makes the access key when this link has none yet (linked before 1.8.0),
   * or a new one with `renew` (--new-token). Only at startup, before anything
   * uses the session: it saves the state a refresh would save too. */
  async keepAccessKey({ renew = false } = {}) {
    if (this.state && (renew || !this.state.access)) await this.save({ ...this.state, access: newAccessKey() });
    return this.accessKey;
  }

  call(kind, name, args = {}, token = null) {
    const client = new ConvexHttpClient(this.url, { logger: false });
    if (token) client.setAuth(token);
    return client[kind](name, args);
  }

  async save(state) {
    this.state = state;
    if (!state) {
      await rm(this.file, { force: true });
      return;
    }
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Trades a link code from the app for a session on its account. */
  async link(code) {
    const result = await this.call('action', 'auth:signIn', { provider: 'device', params: { code: String(code || ''), name: this.name } });
    const tokens = result?.tokens;
    const userId = userIdOf(tokens?.token);
    if (!userId) throw new Error("That link didn't work. Open Holly Bot and try again.");
    await this.save({ url: this.url, userId, token: tokens.token, refreshToken: tokens.refreshToken, linkedAt: Date.now(), access: newAccessKey() });
    return userId;
  }

  /** A JWT with at least a minute left, renewed when needed; null once the
   * link has ended. Throws when the server can't be reached. */
  async token({ force = false } = {}) {
    if (!this.state) return null;
    if (!force && msLeft(this.state.token) > 60_000) return this.state.token;
    this.refreshing ||= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refresh() {
    const state = this.state;
    if (!state) return null;
    const result = await this.call('action', 'auth:signIn', { refreshToken: state.refreshToken });
    if (this.state !== state) return this.state?.token ?? null; // unlinked or renewed meanwhile
    if (!result?.tokens) {
      // No tokens back: the session is over (unlinked in the app, or the account deleted).
      await this.save(null);
      this.onEnded();
      return null;
    }
    await this.save({ ...state, token: result.tokens.token, refreshToken: result.tokens.refreshToken });
    return result.tokens.token;
  }

  /** The link's JWT, for a request that carries it itself (Holly Bot's AI,
   * src/core/providers); "Not signed in" once the link has ended. `force`
   * renews it first. */
  async tokenOf({ force = false } = {}) {
    const as = this.userId;
    const token = await this.token({ force });
    if (!token || userIdOf(token) !== as) throw new Error('Not signed in');
    return token;
  }

  /** Calls a Convex function as the linked account; "Not signed in" once the
   * link has ended (or was replaced by another account's). */
  async authed(kind, name, args = {}) {
    const as = this.userId;
    const check = (token) => {
      if (!token || userIdOf(token) !== as) throw new Error('Not signed in');
      return token;
    };
    const token = check(await this.token());
    try {
      return await this.call(kind, name, args, token);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      return this.call(kind, name, args, check(await this.token({ force: true })));
    }
  }

  /** Ends the link: the session on the server (if it answers soon) and here. */
  async unlink() {
    const token = this.state && msLeft(this.state.token) > 0 ? this.state.token : null;
    if (token) await Promise.race([this.call('action', 'auth:signOut', {}, token).catch(() => {}), sleep(5000)]);
    await this.save(null);
  }

  /** Links itself again once the session is getting old, then ends the old
   * one. True when it did (the account knows it as a new computer). */
  async renewIfDue() {
    if (!this.state || Date.now() - this.state.linkedAt < RENEW_AFTER) return false;
    const oldToken = await this.token();
    const old = this.state;
    if (!oldToken || !old) return false;
    const { code, hash } = await makeLinkCode();
    await this.authed('mutation', 'devices:createLink', { codeHash: hash });
    const result = await this.call('action', 'auth:signIn', { provider: 'device', params: { code, name: this.name } });
    if (!result?.tokens || userIdOf(result.tokens.token) !== old.userId) throw new Error('The link could not be renewed');
    await this.save({ ...old, token: result.tokens.token, refreshToken: result.tokens.refreshToken, linkedAt: Date.now() });
    await this.call('action', 'auth:signOut', {}, oldToken).catch(() => {});
    this.log.log?.('  Renewed this computer\'s link to your Holly Bot account.');
    return true;
  }
}
