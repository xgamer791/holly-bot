import { html, useEffect, useState } from '../../vendor/preact.js';
import { account } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';

// The subscription page, on the same white page as signing in. Holly Bot opens
// only for an account with an active subscription, so src/main.js shows this
// instead of the app right after an account is created, and whenever its
// subscription isn't active. Plans are the server's (convex/lib/plans.ts),
// billed monthly or yearly through Stripe Checkout (convex/billing.ts). Back
// from paying, it waits for Stripe's word, then opens the app. A payment that
// didn't go through leads to Stripe's billing portal instead.

const EVERY = { month: 'Monthly', year: 'Yearly' };
/** A subscription in one of these needs something done before Holly Bot opens. */
const NEEDS = ['past_due', 'unpaid', 'incomplete', 'paused'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** $49, $1,790 or $40.83. */
export function money(cents) {
  const digits = cents % 100 ? 2 : 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

export function longDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

/** What paying yearly saves on a plan, in cents. */
function yearlySaving(plan) {
  return plan.price.month * 12 - plan.price.year;
}

/** How many months yearly billing gives free, when every plan gives the same. */
function monthsFree(plans) {
  const months = new Set(plans.map((plan) => Math.round(yearlySaving(plan) / plan.price.month)));
  const [n] = months;
  return months.size === 1 && n > 0 ? n : 0;
}

/** The server's message for a call it turned down, or `fallback`. */
function serverSays(err, fallback) {
  if (typeof err?.data === 'string') return err.data;
  if (err?.name === 'TypeError') return "Couldn't reach Holly Bot's server. Check your connection and try again.";
  return fallback;
}

/** Where Stripe sends people back to: this page's address, which the server
 * checks against the places Holly Bot may return to (convex/auth.ts). */
const here = () => `${location.origin}${location.pathname}`;

/**
 * `status` is billing:status. `back` says what the person just came back
 * from: 'paid' (Checkout), 'cancelled' (left Checkout), 'billing' (the portal)
 * or null. `onActive` opens the app once the subscription is active.
 */
export function SubscribeScreen({ status: first, back, onActive, onSignOut, onDeleteAccount }) {
  const [status, setStatus] = useState(first);
  const sub = status.subscription;
  const plans = status.plans || [];
  const [every, setEvery] = useState(sub?.interval === 'year' ? 'year' : 'month');
  const [chosen, setChosen] = useState(plans.some((p) => p.id === sub?.plan) ? sub.plan : plans[0]?.id);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // Just paid: Stripe's word can take a moment. 'slow' once it's taken a while.
  const [waiting, setWaiting] = useState(back === 'paid' ? 'yes' : null);
  const [deleting, setDeleting] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    // Who is signed in arrives a moment after a new sign-in.
    const off = account.on(() => setTick((n) => n + 1));
    // The back button can bring this page back just as it was left for Stripe.
    const onShow = (e) => e.persisted && setBusy(null);
    addEventListener('pageshow', onShow);
    return () => {
      off();
      removeEventListener('pageshow', onShow);
    };
  }, []);

  useEffect(() => {
    if (waiting !== 'yes') return undefined;
    let stopped = false;
    (async () => {
      for (let i = 0; i < 20 && !stopped; i++) {
        await sleep(i ? 3000 : 1500);
        if (stopped) return;
        try {
          const next = await account.authed('action', 'billing:sync');
          if (stopped) return;
          setStatus(next);
          if (next.active) return onActive(next);
          if (NEEDS.includes(next.subscription?.status) && next.subscription.status !== 'incomplete') return setWaiting(null);
        } catch { /* offline for a moment: ask again */ }
      }
      if (!stopped) setWaiting('slow');
    })();
    return () => {
      stopped = true;
    };
  }, [waiting]);

  const run = (name, fn) => async () => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      console.warn(name, err);
      setBusy(null);
      setError(serverSays(err, name === 'checkout' ? "Couldn't start checkout. Please try again." : 'Something went wrong. Please try again.'));
    }
  };
  const subscribe = run('checkout', async () => {
    location.assign(await account.authed('action', 'billing:checkout', { plan: chosen, interval: every, returnTo: here() }));
  });
  const manage = run('billing', async () => {
    location.assign(await account.authed('action', 'billing:portal', { returnTo: here() }));
  });
  const check = run('check', async () => {
    const next = await account.authed('action', 'billing:sync');
    setStatus(next);
    if (next.active) return onActive(next);
    setBusy(null);
    if (waiting) setWaiting(null);
    return null;
  });

  const who = account.user?.email || account.user?.name || '';
  const planName = plans.find((p) => p.id === sub?.plan)?.name;
  const accountLinks = html`
    <div class="sub-account">
      ${who && html`<p>Signed in as <b>${who}</b></p>`}
      <div class="sub-account-actions">
        <button disabled=${!!busy} onClick=${onSignOut}>Sign Out</button>
        <span aria-hidden="true">·</span>
        <button disabled=${!!busy} onClick=${() => setDeleting(true)}>Delete Account</button>
      </div>
    </div>`;
  const deleteSheet = deleting && html`<${DeleteSheet} subscribed=${!!sub && !['canceled', 'incomplete_expired'].includes(sub.status)}
    onDelete=${onDeleteAccount} onClose=${() => setDeleting(false)} />`;

  if (waiting) {
    return html`
      <div class="hello">
        <div class="hello-canvas">
          <div class="hello-hero device">
            <${Avatar} shape="cloud" color="#111113" eyeColor="#ffffff" size=${72} activity="working" />
            <h1 class="device-title">${waiting === 'slow' ? 'Still waiting for Stripe' : 'Setting up your subscription'}</h1>
            <p class="device-text">${waiting === 'slow'
              ? "Stripe hasn't confirmed your payment yet. Holly Bot opens as soon as it does."
              : 'Thanks! Holly Bot opens as soon as Stripe confirms your payment.'}</p>
            ${waiting === 'yes' && html`<span class="spinner" role="status" aria-label="Waiting for Stripe"></span>`}
            ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          </div>
          ${waiting === 'slow' && html`
            <div class="hello-dock">
              <div class="hello-ctas">
                <button class="hello-cta" disabled=${!!busy} onClick=${check}>${busy === 'check' ? html`<span class="spinner"></span>` : 'Check Again'}</button>
              </div>
              ${accountLinks}
            </div>`}
        </div>
        ${deleteSheet}
      </div>`;
  }

  // A subscription that isn't over but doesn't pay for Holly Bot right now
  // (a renewal that didn't go through, a payment still processing, paused),
  // or one Stripe hasn't confirmed lately: sorted out in Stripe's portal, not
  // with a second subscription.
  const stale = sub && ['active', 'trialing'].includes(sub.status);
  if (sub && (NEEDS.includes(sub.status) || stale)) {
    const plan = planName ? `${planName} plan` : 'subscription';
    const safe = 'Your bots, chats and memories are safe in your account.';
    const say = {
      past_due: ["Your payment didn't go through", `Holly Bot couldn't renew your ${plan}. Update your payment method to keep using Holly Bot. ${safe}`, 'Update Payment Method'],
      unpaid: ["Your payment didn't go through", `Holly Bot couldn't renew your ${plan}. Update your payment method to keep using Holly Bot. ${safe}`, 'Update Payment Method'],
      paused: ['Your subscription is paused', `Resume your ${plan} to keep using Holly Bot. ${safe}`, 'Manage Billing'],
      incomplete: ['Your payment is processing', 'Holly Bot opens as soon as Stripe confirms your payment.', null],
    }[sub.status] || ['Checking your subscription', `Holly Bot couldn't confirm your ${plan} with Stripe just now. Check again in a minute.`, null];
    const [title, text, fix] = say;
    return html`
      <div class="hello">
        <div class="hello-canvas">
          <div class="hello-hero device">
            <${Avatar} shape="cloud" color="#111113" eyeColor="#ffffff" size=${72} expression="sleepy" />
            <h1 class="device-title">${title}</h1>
            <p class="device-text">${text}</p>
            ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          </div>
          <div class="hello-dock">
            <div class="hello-ctas">
              ${fix && html`<button class="hello-cta" disabled=${!!busy} onClick=${manage}>${busy === 'billing' ? html`<span class="spinner"></span>` : fix}</button>`}
              <button class=${`hello-cta${fix ? ' secondary' : ''}`} disabled=${!!busy} onClick=${check}>${busy === 'check' ? html`<span class="spinner"></span>` : 'Check Again'}</button>
              ${!fix && html`<button class="hello-cta secondary" disabled=${!!busy} onClick=${manage}>${busy === 'billing' ? html`<span class="spinner"></span>` : 'Manage Billing'}</button>`}
            </div>
            ${accountLinks}
          </div>
        </div>
        ${deleteSheet}
      </div>`;
  }

  const plan = plans.find((p) => p.id === chosen) || plans[0];
  const free = monthsFree(plans);
  const ended = sub?.status === 'canceled' && (sub.endsAt || sub.periodEnd);
  const notice = back === 'cancelled'
    ? 'Checkout was cancelled, and nothing was charged.'
    : ended
      ? `Your ${planName ? `${planName} plan` : 'subscription'} ended on ${longDate(sub.endsAt || sub.periodEnd)}. Your bots, chats and memories are still in your account: choose a plan to pick up where you left off.`
      : null;

  return html`
    <div class="hello">
      <div class="hello-canvas sub-canvas">
        <header class="sub-head">
          <${Avatar} shape="cloud" color="#111113" eyeColor="#ffffff" size=${64} live />
          <h1 class="sub-title">Choose your plan</h1>
          <p class="sub-lead">Every plan runs your bots on a dedicated server of their own.</p>
        </header>
        ${notice && html`<p class="sub-notice" role="status">${notice}</p>`}

        <div class=${`sub-cycle ${every}`} role="radiogroup" aria-label="Billing">
          ${Object.entries(EVERY).map(([id, label]) => html`
            <label key=${id} class=${every === id ? 'on' : ''}>
              <input type="radio" name="every" value=${id} checked=${every === id} onChange=${() => setEvery(id)} />
              <span>${label}</span>
              ${id === 'year' && free > 0 && html`<span class="sub-free">${free} ${free === 1 ? 'month' : 'months'} free</span>`}
            </label>`)}
        </div>

        <div class="sub-plans" role="radiogroup" aria-label="Plan">
          ${plans.map((p, i) => html`
            <label key=${p.id} class=${`sub-plan${p.id === plan?.id ? ' on' : ''}`} style=${`--i:${i}`}>
              <input type="radio" name="plan" value=${p.id} checked=${p.id === plan?.id} onChange=${() => setChosen(p.id)} />
              <span class="sub-radio" aria-hidden="true"><${Icon.check} size=${14} sw=${3.2} /></span>
              <span class="sub-name">
                ${p.name}
                ${every === 'year' && yearlySaving(p) > 0 && html`<span class="sub-save">Save ${money(yearlySaving(p))}</span>`}
              </span>
              ${p.note && html`<span class="sub-note">${p.note}</span>`}
              <span class="sub-price" key=${every}><b>${money(p.price[every])}</b><span>/${every}</span></span>
              <span class="sub-specs">
                <span><${Icon.cpu} size=${15} /> ${p.cpu} CPU</span>
                <span><${Icon.memory} size=${15} /> ${p.memoryGb} GB RAM</span>
              </span>
            </label>`)}
        </div>

        <section class="sub-includes">
          <h2>Every plan includes</h2>
          <ul>
            <li><${Icon.bot} size=${18} /><span>Your bots, chats and memories in your account, on every device</span></li>
            <li><${Icon.key} size=${18} /><span>Use your own AI key: DeepSeek, Claude, OpenAI, Grok and more</span></li>
            <li><${Icon.mail} size=${18} /><span>Gmail, Outlook and GitHub for your bots to use</span></li>
            <li><${Icon.check} size=${18} /><span>Cancel anytime in Settings</span></li>
          </ul>
        </section>

        ${accountLinks}
        <p class="auth-legal sub-legal">
          <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
        </p>

        <div class="sub-dock">
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          ${!status.ready && html`<p class="sub-fine">Subscriptions aren't set up on Holly Bot's server yet.</p>`}
          <button class="hello-cta" disabled=${!!busy || !status.ready || !plan} onClick=${subscribe}>
            ${busy === 'checkout' ? html`<span class="spinner"></span>` : plan ? `Subscribe for ${money(plan.price[every])}/${every}` : 'Subscribe'}
          </button>
          <p class="sub-fine">Renews every ${every} until you cancel. Secure checkout with Stripe.</p>
        </div>
      </div>
      ${deleteSheet}
    </div>`;
}

/** Deleting the account from here, for someone who'd rather not subscribe:
 * the same as Settings → Delete Account, which they can't reach without a
 * subscription. */
function DeleteSheet({ subscribed, onDelete, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [busy]);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      console.error('delete account', err);
      setBusy(false);
      setError("Your account couldn't be deleted. Check your connection and try again.");
    }
  };
  return html`
    <div class="hello-scrim" onClick=${() => !busy && onClose()}></div>
    <section class="hello-sheet" role="dialog" aria-modal="true" aria-label="Delete your account">
      <div class="hello-grabber"></div>
      <h2>Delete your account?</h2>
      <p class="sub-sheet-text">This permanently deletes your Holly Bot account and everything in it: bots, chats, memories, files, routines, settings and API keys.${subscribed ? ' Your subscription is cancelled right away.' : ''} It can't be undone.</p>
      ${error && html`<p class="auth-error" role="alert">${error}</p>`}
      <button class="hello-cta danger" disabled=${busy} onClick=${remove}>${busy ? html`<span class="spinner"></span>` : 'Delete Account'}</button>
      <button class="hello-sheet-cancel" disabled=${busy} onClick=${onClose}>Cancel</button>
    </section>`;
}
