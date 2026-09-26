import { html, useEffect, useState } from '../../vendor/preact.js';
import { account, friendlyError } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';
import { listText, tr, trn, trx } from './i18n.js';

// What people see before they have signed in: Macronaut's welcome and sign-in
// screens on a plain white page. A stacked wordmark with two identical actions
// docked underneath, then Sign In and Create Account pages that sign in with
// Apple or Google. Each screen is a hash route, so the phone's back gesture works.
// Holly Bot needs an account: everything it keeps lives in the account.
// After signing in, the same white page asks what to do with anything this
// device kept from before accounts, and says so when the account can't load.

const SCREENS = ['welcome', 'sign-in', 'create-account'];
const PROVIDERS = { apple: 'Apple', google: 'Google' };

export function screenFromHash() {
  const screen = location.hash.replace(/^#\//, '');
  return SCREENS.includes(screen) ? screen : 'welcome';
}

/** Apple's logo, which Apple's guidelines allow on a custom button kept in
 * its own black and white. */
function AppleLogo() {
  return html`<svg width="17" height="21" viewBox="0 0 384 512" aria-hidden="true"><path fill="currentColor" d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-36.8-2.8-77 21.3-91.7 21.3-15.5 0-51.1-20.3-79.1-20.3C56.9 141.1 0 184.7 0 273.5c0 26.2 4.8 53.3 14.4 81.2 12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-57.7-90.1-57.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" /></svg>`;
}

function GoogleLogo() {
  return html`<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>`;
}

/**
 * Apple and Google, worded for signing in or signing up (the backend does the
 * same either way: the first sign-in creates the account). Asks the server
 * which of the two are set up, so a missing one says so here instead of
 * opening an error page, and offers to ask again when the server can't be reached.
 */
function ProviderButtons({ signUp, from, notice }) {
  const [options, setOptions] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(notice || null);

  const check = async () => {
    try {
      const next = await account.signInOptions();
      setOptions(next);
      return next;
    } catch (err) {
      setOptions({ problem: friendlyError(err) });
      return null;
    }
  };

  useEffect(() => {
    check();
    // The back button can bring this page back exactly as it was left for Google.
    const onShow = (e) => e.persisted && setBusy(null);
    addEventListener('pageshow', onShow);
    return () => removeEventListener('pageshow', onShow);
  }, []);

  const start = async (provider) => {
    setBusy(provider);
    setError(null);
    const ready = options && !options.problem ? options : await check();
    if (!ready?.[provider]) {
      setBusy(null);
      if (ready) setError(tr("{provider} sign-in isn't set up yet.", { provider: PROVIDERS[provider] }));
      return;
    }
    try {
      await account.signIn(provider, from);
    } catch (err) {
      setBusy(null);
      setError(friendlyError(err));
    }
  };

  const unavailable = options?.problem
    || (options && !options.apple && !options.google ? tr("Sign-in isn't set up on Holly Bot's server yet.") : null);
  const missing = !unavailable && options && Object.keys(PROVIDERS).find((provider) => !options[provider]);
  const off = (provider) => !!busy || (!!options && !options.problem && !options[provider]);
  const button = (provider, Logo) => html`
    <button class=${`auth-btn ${provider}`} disabled=${off(provider)} onClick=${() => start(provider)}>
      ${busy === provider ? html`<span class="spinner"></span>` : html`<${Logo} />`}
      <span>${signUp ? tr('Sign up with {provider}', { provider: PROVIDERS[provider] }) : tr('Continue with {provider}', { provider: PROVIDERS[provider] })}</span>
    </button>`;

  return html`
    <div class="auth-providers">
      ${button('apple', AppleLogo)}
      ${button('google', GoogleLogo)}
    </div>
    ${missing && html`<p class="auth-note">${tr("{provider} sign-in isn't set up yet.", { provider: PROVIDERS[missing] })}</p>`}
    ${error && html`<p class="auth-error" role="alert">${error}</p>`}
    ${unavailable && html`
      <div class="auth-unavailable">
        <p>${unavailable}</p>
        <button class="auth-skip" onClick=${() => {
          setOptions(null);
          check();
        }}>${tr('Try again')}</button>
      </div>`}
    <${LegalNote} />`;
}

/** The agreement people make by signing in, with both documents a tap away. */
function LegalNote() {
  return html`<p class="auth-legal">${trx("By continuing, you agree to Holly Bot's {terms} and {privacy}.", {
    terms: html`<a href="terms.html" target="_blank" rel="noopener">${tr('Terms of Service')}</a>`,
    privacy: html`<a href="privacy.html" target="_blank" rel="noopener">${tr('Privacy Policy')}</a>`,
  })}</p>`;
}

function MoreOptions({ onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`
    <div class="hello-scrim" onClick=${onClose}></div>
    <section class="hello-sheet" role="dialog" aria-modal="true" aria-label=${tr('More options')}>
      <div class="hello-grabber"></div>
      <h2>${tr('More options')}</h2>
      <${ProviderButtons} from="sign-in" />
      <button class="hello-sheet-cancel" onClick=${onClose}>${tr('Cancel')}</button>
    </section>`;
}

/** Wordmark in the middle, Create Account and Sign In docked at the bottom,
 * then More options. `notice` says what just happened (a sign-in that failed). */
function WelcomeScreen({ go, notice }) {
  const [more, setMore] = useState(false);
  return html`
    <div class="hello-canvas">
      <div class="hello-hero">
        <${Avatar} shape="cloud" color="blue" size=${84} live />
        <h1 class="hello-wordmark" aria-label="Holly Bot">
          <span class="w-holly" aria-hidden="true">HOLLY</span>
          <span class="w-bot" aria-hidden="true">bot</span>
        </h1>
        ${notice && html`<p class="hello-note" role="status">${notice}</p>`}
      </div>
      <div class="hello-dock">
        <div class="hello-ctas">
          <button class="hello-cta" onClick=${() => go('create-account')}>${tr('Create Account')}</button>
          <button class="hello-cta" onClick=${() => go('sign-in')}>${tr('Sign In')}</button>
        </div>
        <button class="hello-more" onClick=${() => setMore(true)}>${tr('More options')}</button>
      </div>
      ${more && html`<${MoreOptions} onClose=${() => setMore(false)} />`}
    </div>`;
}

/** Sign In and Create Account: a back chevron and a centred title, then the
 * sign-in buttons and a link across to the other page. */
function AuthScreen({ screen, notice, back, go }) {
  const signUp = screen === 'create-account';
  return html`
    <div class="hello-canvas auth">
      <header class="auth-head">
        <button class="auth-back" aria-label=${tr('Back')} onClick=${back}><${Icon.back} size=${28} /></button>
        <h1>${signUp ? tr('Create Account') : tr('Sign In')}</h1>
        <span class="auth-back" aria-hidden="true"></span>
      </header>
      <div class="auth-form">
        <p class="auth-lead">${signUp
          ? tr("Holly Bot uses your Apple or Google account, so there's no new password to remember.")
          : tr('Welcome back. Use the Apple or Google account you signed up with.')}</p>
        <${ProviderButtons} signUp=${signUp} from=${screen} notice=${notice} />
        <button class="auth-switch" onClick=${() => go(signUp ? 'sign-in' : 'create-account', { replace: true })}>
          <span>${signUp ? tr('Already have an account?') : tr("Don't have an account?")} </span>
          <u>${signUp ? tr('Sign In.') : tr('Create Account.')}</u>
        </button>
      </div>
    </div>`;
}

/**
 * The signed-out app. `start` is the screen to open on, `notice` a message for
 * it (a sign-in that didn't finish, an account just deleted).
 */
export function WelcomeFlow({ start = 'welcome', notice = null }) {
  const [view, setView] = useState({ screen: start, notice });

  useEffect(() => {
    const onPop = () => setView({ screen: screenFromHash(), notice: null });
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const go = (screen, { replace = false } = {}) => {
    const url = `${location.pathname}${location.search}#/${screen}`;
    if (replace) history.replaceState(history.state, '', url);
    else history.pushState({ welcome: true }, '', url);
    setView({ screen, notice: null });
  };
  // Back to the welcome screen: one step back when this flow put the page
  // here, otherwise (it opened here) replace it.
  const back = () => (history.state?.welcome ? history.back() : go('welcome', { replace: true }));

  return html`
    <div class="hello">
      ${view.screen === 'welcome'
        ? html`<${WelcomeScreen} go=${go} notice=${view.notice} />`
        : html`<${AuthScreen} key=${view.screen} screen=${view.screen} notice=${view.notice} back=${back} go=${go} />`}
    </div>`;
}

/** Who is signed in, for the screens below: a name, an email, or neither. */
function signedInAs() {
  const user = account.user;
  return user?.email || user?.name || '';
}

/**
 * Right after signing in on a device that kept bots and chats from before
 * Holly Bot had accounts (`found`: { bots, chats, computer }). They go into
 * the account that just signed in or are deleted; either way they leave the
 * device, so they're never offered to another account. Deleting asks twice.
 * Signing out first lets someone pick a different account for them.
 */
export function DeviceDataScreen({ found, onAdd, onDelete, onSignOut }) {
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const parts = [
    found.bots && trn(found.bots, '{n} bot', '{n} bots'),
    found.chats && trn(found.chats, '{n} chat', '{n} chats'),
    !found.bots && !found.chats && found.settings && tr('your settings and keys'),
    found.computer && tr('a link to your Holly Bot Computer'),
  ].filter(Boolean);
  const what = parts.length > 1 ? listText(parts) : parts[0] || tr('settings');
  const run = (name, fn) => async () => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setError(String(err?.message || err));
      setBusy(null);
    }
  };
  const remove = () => {
    if (!confirming) return setConfirming(true);
    return run('delete', onDelete)();
  };
  const who = signedInAs();
  return html`
    <div class="hello">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape="cloud" color="blue" size=${72} />
          <h1 class="device-title">${tr('Found on this device')}</h1>
          <p class="device-text">${who
            ? trx("This device has {what} from before Holly Bot had accounts. Add them to your account (**{who}**) to keep them, or delete them. Either way they're removed from this device.", { what, who })
            : tr("This device has {what} from before Holly Bot had accounts. Add them to your account to keep them, or delete them. Either way they're removed from this device.", { what })}</p>
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
        </div>
        <div class="hello-dock">
          <div class="hello-ctas">
            <button class="hello-cta" disabled=${!!busy} onClick=${run('add', onAdd)}>
              ${busy === 'add' ? html`<span class="spinner"></span>` : tr('Add to My Account')}
            </button>
            <button class=${`hello-cta secondary${confirming ? ' danger' : ''}`} disabled=${!!busy} onClick=${remove}>
              ${busy === 'delete' ? html`<span class="spinner"></span>` : confirming ? tr('Tap Again to Delete Them') : tr('Delete from This Device')}
            </button>
          </div>
          <button class="hello-more" disabled=${!!busy} onClick=${run('sign-out', onSignOut)}>${tr('Use a Different Account')}</button>
        </div>
      </div>
    </div>`;
}

/**
 * A Holly Bot Computer that isn't linked to an account yet, opened while signed
 * in. Linking keeps its bots in the account: what it has now moves in, and it
 * goes on running them (computer/src/home.mjs). `onLink` can take a while.
 */
export function LinkComputerScreen({ name, onLink, onSignOut, onDisconnect, auto = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const who = signedInAs();
  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLink();
    } catch (err) {
      console.error(err);
      setError(String(err?.message || err));
      setBusy(false);
    }
  };
  // On the computer's own page, signing in is enough: it links right away (src/main.js).
  useEffect(() => {
    if (auto) link();
  }, []);
  return html`
    <div class="hello">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape="cloud" color="blue" size=${72} />
          <h1 class="device-title">${tr('Keep your bots in your account')}</h1>
          <p class="device-text">${who
            ? trx('Link **{name}** to your account (**{who}**). Its bots, chats, memories and keys move into your account, and {name} keeps running your bots around the clock.', { name, who })
            : trx('Link **{name}** to your account. Its bots, chats, memories and keys move into your account, and {name} keeps running your bots around the clock.', { name })}</p>
          <p class="hello-warning" role="note">${trx("**Keep {name}'s link private, like a password.** Anyone who has it can control {name} and see your bots, chats and files, and a Wi-Fi link opens it without signing in. If a link gets out, restart Holly Bot Computer with {flag} and the old links stop working.", { name, flag: html`<code>--new-token</code>` })}</p>
          ${busy && html`<p class="hello-note" role="status">${tr('Moving your bots into your account. This can take a minute.')}</p>`}
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
        </div>
        <div class="hello-dock">
          <div class="hello-ctas">
            <button class="hello-cta" disabled=${busy} onClick=${link}>${busy ? html`<span class="spinner"></span>` : tr('Add to My Account')}</button>
            <button class="hello-cta secondary" disabled=${busy} onClick=${onSignOut}>${tr('Use a Different Account')}</button>
          </div>
          <button class="hello-more" disabled=${busy} onClick=${onDisconnect}>${tr('Disconnect from {name}', { name })}</button>
        </div>
      </div>
    </div>`;
}

/** A Holly Bot Computer linked to a different account than the one signed in. */
export function OtherAccountScreen({ name, onSignOut, onDisconnect }) {
  return html`
    <div class="hello">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape="cloud" color="blue" size=${72} expression="sleepy" />
          <h1 class="device-title">${tr('Linked to another account')}</h1>
          <p class="device-text">${trx('**{name}** keeps its bots in a different Holly Bot account. Sign in with that account to use it here.', { name })}</p>
        </div>
        <div class="hello-dock">
          <div class="hello-ctas">
            <button class="hello-cta" onClick=${onSignOut}>${tr('Use a Different Account')}</button>
          </div>
          <button class="hello-more" onClick=${onDisconnect}>${tr('Disconnect from {name}', { name })}</button>
        </div>
      </div>
    </div>`;
}

/** The account couldn't be loaded (offline, or the server had a problem). */
export function ProblemScreen({ message, onRetry, onSignOut }) {
  const [busy, setBusy] = useState(false);
  return html`
    <div class="hello">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape="cloud" color="blue" size=${72} expression="sleepy" />
          <h1 class="device-title">${tr("Couldn't load your account")}</h1>
          <p class="device-text">${message}</p>
        </div>
        <div class="hello-dock">
          <div class="hello-ctas">
            <button class="hello-cta" disabled=${busy} onClick=${async () => {
              setBusy(true);
              await onRetry();
              setBusy(false);
            }}>${busy ? html`<span class="spinner"></span>` : tr('Try Again')}</button>
          </div>
          ${onSignOut && html`<button class="hello-more" disabled=${busy} onClick=${onSignOut}>${tr('Sign Out')}</button>`}
        </div>
      </div>
    </div>`;
}
