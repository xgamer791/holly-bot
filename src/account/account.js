import { ConvexHttpClient } from '../../vendor/convex.js';
import { CONVEX_URL, SITE } from './config.js';
import { tr } from '../ui/i18n.js';

// Holly Bot accounts: Sign in with Apple or Google, kept in Holly Bot's own
// Convex database (CONVEX.md). This speaks the same protocol as Convex Auth's
// React client, which a Preact app with no build step can't use:
//   1. auth:signIn {provider, params: {redirectTo}} returns a URL on the
//      deployment's site and a one-time verifier, which stays in this browser.
//   2. Google or Apple sends the person back here with ?code=…, and the code plus
//      the verifier buy a session: a one-hour JWT and a refresh token.
//   3. auth:signIn {refreshToken} trades the refresh token for a new pair when
//      the JWT runs out. Refresh tokens rotate; reusing an old one ends the session.
// Storage keys match Convex Auth's own, so a session survives switching clients.

export { CONVEX_URL, SITE };
const USER_KEY = 'holly.account';
const PENDING_KEY = 'holly.signInPending';

/** Where the app asks you to sign in: the Holly Bot site and localhost
 * (Holly Computer's own page, local development), the only places Google and
 * Apple can send people back to (convex/auth.ts). Holly Computer's tunnel
 * address hands over to the site instead (src/main.js). A Wi-Fi address can't
 * finish a sign-in, so there the pairing token alone protects the app. Browser
 * automation on localhost (the e2e scripts) skips it unless the URL has ?signin. */
export function signInWorksHere(loc = location) {
  if (`${loc.origin}${loc.pathname}`.startsWith(SITE)) return true;
  const local = loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');
  return local && (!navigator.webdriver || /[?&]signin\b/.test(loc.search));
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
}

function readJson(key) {
  try {
    return JSON.parse(read(key) || 'null');
  } catch {
    return null;
  }
}

function isNetworkError(err) {
  return err?.name === 'TypeError' && /fetch|network|load failed|terminated/i.test(err.message || '');
}

function claims(jwt) {
  try {
    return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** The account a session JWT belongs to (its subject is `userId|sessionId`). */
function userIdOf(jwt) {
  return (jwt && claims(jwt)?.sub?.split('|')[0]) || null;
}

/** Milliseconds until a JWT expires (0 when it can't be read). */
function msLeft(jwt) {
  const exp = claims(jwt)?.exp;
  return exp ? exp * 1000 - Date.now() : 0;
}

function isAuthError(err) {
  return /unauthenticated|invalidauthheader|oidc|expired|not signed in/i.test(err?.message || '');
}

const queues = {};
/** Runs `fn` as the only holder of `name` across this browser's tabs, so two
 * tabs never spend the same refresh token. */
function exclusive(name, fn) {
  if (navigator.locks?.request) return navigator.locks.request(name, fn);
  const run = (queues[name] || Promise.resolve()).then(fn, fn);
  queues[name] = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turns a failed call into something a person can act on. */
export function friendlyError(err) {
  const message = String(err?.message || err || '');
  if (isNetworkError(err)) return tr("Couldn't reach Holly Bot's server. Check your connection and try again.");
  if (/could not find public function/i.test(message)) return tr("Sign-in isn't set up on Holly Bot's server yet.");
  if (/rate limit|too many/i.test(message)) return tr('Too many attempts. Wait a minute and try again.');
  return tr('Something went wrong signing in. Please try again.');
}

class Account {
  constructor(url) {
    const ns = url.replace(/[^a-zA-Z0-9]/g, '');
    this.url = url;
    this.keys = {
      verifier: `__convexAuthOAuthVerifier_${ns}`,
      jwt: `__convexAuthJWT_${ns}`,
      refresh: `__convexAuthRefreshToken_${ns}`,
    };
    this.user = readJson(USER_KEY);
    this.listeners = new Set();
    // Another tab signed in, signed out or refreshed who you are.
    addEventListener('storage', (e) => {
      if (e.key === USER_KEY) this.user = readJson(USER_KEY);
      if (e.key === null || e.key === USER_KEY || e.key === this.keys.jwt) this.emit();
    });
  }

  get signedIn() {
    return !!read(this.keys.jwt);
  }

  /** The signed-in account's id. */
  get userId() {
    return userIdOf(read(this.keys.jwt));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  call(kind, name, args = {}, token = null) {
    const client = new ConvexHttpClient(this.url, { logger: false });
    if (token) client.setAuth(token);
    return client[kind](name, args);
  }

  /** auth:signIn without a session, retried through brief network drops
   * (phones lose the connection while a page is in the background). */
  async exchange(args) {
    for (const wait of [500, 2000]) {
      try {
        return await this.call('action', 'auth:signIn', args);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        await sleep(wait + Math.random() * 100);
      }
    }
    return this.call('action', 'auth:signIn', args);
  }

  store(tokens) {
    write(this.keys.jwt, tokens?.token ?? null);
    write(this.keys.refresh, tokens?.refreshToken ?? null);
    if (!tokens) {
      this.user = null;
      write(USER_KEY, null);
    }
    this.emit();
  }

  /** Which sign-in buttons can work right now: {apple, google}. */
  signInOptions() {
    return this.call('query', 'account:signInOptions');
  }

  /** Leaves for Google's or Apple's sign-in. They send the person back to this
   * address with ?code=…, which finishSignIn() redeems on the next load.
   * `from` is the screen to reopen if the sign-in doesn't finish. */
  async signIn(provider, from) {
    const redirectTo = `${location.origin}${location.pathname}${location.search}`;
    const result = await this.call('action', 'auth:signIn', { provider, params: { redirectTo } });
    if (!result?.redirect || !result.verifier) throw new Error(`${provider} sign-in could not be started.`);
    write(this.keys.verifier, result.verifier);
    write(PENDING_KEY, JSON.stringify({ from, at: Date.now() }));
    location.assign(result.redirect);
  }

  /** Finishes a sign-in when Google or Apple sent the person back here with
   * ?code=…, trading the code and this browser's verifier for a session.
   * Returns 'signed-in'; or {from, error} when a sign-in started here didn't
   * finish (cancelled, expired, unreachable), so the screen it was started
   * from can say so; or null when none was under way. */
  async finishSignIn() {
    const pending = readJson(PENDING_KEY);
    write(PENDING_KEY, null);
    const from = pending?.from || 'sign-in';
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    if (!code) {
      // Convex sends people back without a code when they cancel or the provider fails.
      const recent = pending && Date.now() - pending.at < 15 * 60 * 1000;
      return recent ? { from, error: tr("Sign-in didn't finish. Please try again.") } : null;
    }
    url.searchParams.delete('code');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    const verifier = read(this.keys.verifier) ?? undefined;
    write(this.keys.verifier, null);
    try {
      const result = await this.exchange({ params: { code }, verifier });
      if (!result?.tokens) return { from, error: tr("That sign-in didn't finish. Please try again.") };
      this.store(result.tokens);
      return 'signed-in';
    } catch (err) {
      return { from, error: friendlyError(err) };
    }
  }

  /** A JWT with at least a minute left, refreshed when needed; null once the
   * session is over. Throws when the server can't be reached. */
  async token({ force = false } = {}) {
    const current = read(this.keys.jwt);
    if (!current) return null;
    if (!force && msLeft(current) > 60_000) return current;
    return exclusive(this.keys.refresh, async () => {
      const latest = read(this.keys.jwt);
      if (latest !== current) return latest; // another tab just refreshed it
      const refreshToken = read(this.keys.refresh);
      const result = refreshToken ? await this.exchange({ refreshToken }) : null;
      // No tokens back means the session ended (expired, or signed out elsewhere).
      this.store(result?.tokens ?? null);
      return result?.tokens?.token ?? null;
    });
  }

  /** Calls a function as the signed-in account, refreshing the session once if
   * the server turns the token down. Throws when nobody is signed in, or, with
   * `as`, when the session is no longer that account's (someone signed in as
   * another account in another tab), so one account's data is never sent as
   * another's. */
  async authed(kind, name, args = {}, { as = null } = {}) {
    const check = (token) => {
      if (!token || (as && userIdOf(token) !== as)) throw new Error('Not signed in');
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

  /** The session's JWT, for a request that carries it itself (Holly Bot's AI,
   * src/core/providers), when it's still `as`'s: throws "Not signed in"
   * otherwise. `force` renews it first. */
  async tokenOf(as, { force = false } = {}) {
    const token = await this.token({ force });
    if (!token || userIdOf(token) !== as) throw new Error('Not signed in');
    return token;
  }

  /** Loads who is signed in from the database and keeps it for the next
   * launch, so Settings can show it offline. Signs out if the account is gone. */
  async refreshUser() {
    if (!this.signedIn) return null;
    const user = await this.authed('query', 'account:viewer');
    if (!user) {
      this.store(null);
      return null;
    }
    this.user = user;
    write(USER_KEY, JSON.stringify(user));
    this.emit();
    return user;
  }

  /** Ends the session on the server if it answers within a few seconds, and
   * on this device either way, so signing out never hangs on a bad connection.
   * An expired token isn't refreshed for this: once its refresh token is gone
   * from here, the server session can only run out. */
  async signOut() {
    const token = read(this.keys.jwt);
    if (token && msLeft(token) > 0) {
      const ended = this.call('action', 'auth:signOut', {}, token).catch((err) => console.warn('sign out', err));
      await Promise.race([ended, sleep(3000)]);
    }
    this.store(null);
  }
}

export const account = new Account(CONVEX_URL);
