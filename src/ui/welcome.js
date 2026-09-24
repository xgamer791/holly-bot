import { html, useEffect, useState } from '../../vendor/preact.js';
import { account, friendlyError } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';

// What people see before they have signed in: Macronaut's welcome and sign-in
// screens on a plain white page. A stacked wordmark with two identical actions
// docked underneath, then Sign In and Create Account pages that sign in with
// Apple or Google. Each screen is a hash route, so the phone's back gesture works.

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
 * opening an error page. When neither can work right now (not set up yet, or
 * the server can't be reached), offers to carry on without an account.
 */
function ProviderButtons({ signUp, from, notice, onSkip }) {
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
      if (ready) setError(`${PROVIDERS[provider]} sign-in isn't set up yet.`);
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
    || (options && !options.apple && !options.google ? "Sign-in isn't set up on Holly Bot's server yet." : null);
  const missing = !unavailable && options && Object.keys(PROVIDERS).find((provider) => !options[provider]);
  const off = (provider) => !!busy || (!!options && !options.problem && !options[provider]);
  const button = (provider, Logo) => html`
    <button class=${`auth-btn ${provider}`} disabled=${off(provider)} onClick=${() => start(provider)}>
      ${busy === provider ? html`<span class="spinner"></span>` : html`<${Logo} />`}
      <span>${signUp ? 'Sign up' : 'Continue'} with ${PROVIDERS[provider]}</span>
    </button>`;

  return html`
    <div class="auth-providers">
      ${button('apple', AppleLogo)}
      ${button('google', GoogleLogo)}
    </div>
    ${missing && html`<p class="auth-note">${PROVIDERS[missing]} sign-in isn't set up yet.</p>`}
    ${error && html`<p class="auth-error" role="alert">${error}</p>`}
    ${unavailable && html`
      <div class="auth-unavailable">
        <p>${unavailable}</p>
        <button class="auth-skip" onClick=${onSkip}>Continue without an account</button>
      </div>`}`;
}

function MoreOptions({ onClose, onSkip }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`
    <div class="hello-scrim" onClick=${onClose}></div>
    <section class="hello-sheet" role="dialog" aria-modal="true" aria-label="More options">
      <div class="hello-grabber"></div>
      <h2>More options</h2>
      <${ProviderButtons} from="sign-in" onSkip=${onSkip} />
      <button class="hello-sheet-cancel" onClick=${onClose}>Cancel</button>
    </section>`;
}

/** Wordmark in the middle, Create Account and Sign In docked at the bottom,
 * then More options. */
function WelcomeScreen({ go, onSkip }) {
  const [more, setMore] = useState(false);
  return html`
    <div class="hello-canvas">
      <div class="hello-hero">
        <${Avatar} shape="cloud" color="#111113" eyeColor="#ffffff" size=${84} live />
        <h1 class="hello-wordmark" aria-label="Holly Bot">
          <span class="w-holly" aria-hidden="true">HOLLY</span>
          <span class="w-bot" aria-hidden="true">bot</span>
        </h1>
      </div>
      <div class="hello-dock">
        <div class="hello-ctas">
          <button class="hello-cta" onClick=${() => go('create-account')}>Create Account</button>
          <button class="hello-cta" onClick=${() => go('sign-in')}>Sign In</button>
        </div>
        <button class="hello-more" onClick=${() => setMore(true)}>More options</button>
      </div>
      ${more && html`<${MoreOptions} onClose=${() => setMore(false)} onSkip=${onSkip} />`}
    </div>`;
}

/** Sign In and Create Account: a back chevron and a centred title, then the
 * sign-in buttons and a link across to the other page. */
function AuthScreen({ screen, notice, back, go, onSkip }) {
  const signUp = screen === 'create-account';
  return html`
    <div class="hello-canvas auth">
      <header class="auth-head">
        <button class="auth-back" aria-label="Back" onClick=${back}><${Icon.back} size=${28} /></button>
        <h1>${signUp ? 'Create Account' : 'Sign In'}</h1>
        <span class="auth-back" aria-hidden="true"></span>
      </header>
      <div class="auth-form">
        <p class="auth-lead">${signUp
          ? "Holly Bot uses your Apple or Google account, so there's no new password to remember."
          : 'Welcome back. Use the Apple or Google account you signed up with.'}</p>
        <${ProviderButtons} signUp=${signUp} from=${screen} notice=${notice} onSkip=${onSkip} />
        <button class="auth-switch" onClick=${() => go(signUp ? 'sign-in' : 'create-account', { replace: true })}>
          <span>${signUp ? 'Already have an account? ' : "Don't have an account? "}</span>
          <u>${signUp ? 'Sign In.' : 'Create Account.'}</u>
        </button>
      </div>
    </div>`;
}

/**
 * The signed-out app. `start` is the screen to open on, `notice` a message for
 * it (a sign-in that didn't finish). `onSkip` carries on without an account,
 * which is only offered while sign-in can't work.
 */
export function WelcomeFlow({ start = 'welcome', notice = null, onSkip }) {
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
        ? html`<${WelcomeScreen} go=${go} onSkip=${onSkip} />`
        : html`<${AuthScreen} key=${view.screen} screen=${view.screen} notice=${view.notice} back=${back} go=${go} onSkip=${onSkip} />`}
    </div>`;
}
