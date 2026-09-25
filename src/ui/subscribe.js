import { html, useEffect, useState } from '../../vendor/preact.js';
import { account } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';
import { dateText, mark, number, tr, trx } from './i18n.js';

// The subscription page, on the same white page as signing in. Holly Bot opens
// only for an account with an active subscription, so src/main.js shows this
// instead of the app right after an account is created, and whenever its
// subscription isn't active. Plans are the server's (convex/lib/plans.ts),
// paid month to month or, for less, yearly, through Stripe Checkout
// (convex/billing.ts). Back from paying, it waits for Stripe's word, then
// opens the app, while the subscriber's computer is set up (src/main.js). A
// payment that didn't go through leads to Stripe's billing portal instead.

const EVERY = { month: mark('Monthly'), year: mark('Yearly') };
/** A subscription in one of these needs something done before Holly Bot opens. */
const NEEDS = ['past_due', 'unpaid', 'incomplete', 'paused'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** $60, $1,790 or $40.83. */
export function money(cents) {
  const digits = cents % 100 ? 2 : 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

export function longDate(ms) {
  return dateText(ms, { month: 'long', day: 'numeric', year: 'numeric' });
}

/** What paying yearly saves on a plan over a year, in cents. */
function yearlySaving(plan) {
  return plan.price.month * 12 - plan.price.year;
}

/** What paying yearly saves, in percent, when every plan saves the same. */
function yearlyPercent(plans) {
  const percents = new Set(plans.map((plan) => Math.round((yearlySaving(plan) / (plan.price.month * 12)) * 100)));
  const [n] = percents;
  return percents.size === 1 && n > 0 ? n : 0;
}

/** The server's message for a call it turned down, or `fallback`. */
function serverSays(err, fallback) {
  if (typeof err?.data === 'string') return tr(err.data);
  if (err?.name === 'TypeError') return tr("Couldn't reach Holly Bot's server. Check your connection and try again.");
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
export function SubscribeScreen({ status: first, back, onActive, onSignOut }) {
  const [status, setStatus] = useState(first);
  const sub = status.subscription;
  const plans = status.plans || [];
  const [every, setEvery] = useState(sub?.interval === 'year' ? 'year' : 'month');
  const [chosen, setChosen] = useState(plans.some((p) => p.id === sub?.plan) ? sub.plan : plans[0]?.id);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // Just paid: Stripe's word can take a moment. 'slow' once it's taken a while.
  const [waiting, setWaiting] = useState(back === 'paid' ? 'yes' : null);
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
      setError(serverSays(err, name === 'checkout' ? tr("Couldn't start checkout. Please try again.") : tr('Something went wrong. Please try again.')));
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

  const planName = plans.find((p) => p.id === sub?.plan)?.name;
  const accountLinks = html`<${AccountLinks} busy=${!!busy} onSignOut=${onSignOut} />`;

  if (waiting) {
    return html`
      <div class="hello">
        <div class="hello-canvas">
          <div class="hello-hero device">
            <${Avatar} shape="cloud" color="blue" size=${72} activity="working" />
            <h1 class="device-title">${waiting === 'slow' ? tr('Still waiting for Stripe') : tr('Setting up your subscription')}</h1>
            <p class="device-text">${waiting === 'slow'
              ? tr("Stripe hasn't confirmed your payment yet. Setting up your computer starts as soon as it does.")
              : tr('Thanks! Setting up your computer starts as soon as Stripe confirms your payment.')}</p>
            ${waiting === 'yes' && html`<span class="spinner" role="status" aria-label=${tr('Waiting for Stripe')}></span>`}
            ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          </div>
          ${waiting === 'slow' && html`
            <div class="hello-dock">
              <div class="hello-ctas">
                <button class="hello-cta" disabled=${!!busy} onClick=${check}>${busy === 'check' ? html`<span class="spinner"></span>` : tr('Check Again')}</button>
              </div>
              ${accountLinks}
            </div>`}
        </div>
      </div>`;
  }

  // A subscription that isn't over but doesn't pay for Holly Bot right now
  // (a renewal that didn't go through, a payment still processing, paused),
  // or one Stripe hasn't confirmed lately: sorted out in Stripe's portal, not
  // with a second subscription.
  const stale = sub && ['active', 'trialing'].includes(sub.status);
  if (sub && (NEEDS.includes(sub.status) || stale)) {
    const renew = planName
      ? tr("Holly Bot couldn't renew your {plan} plan. Update your payment method to keep using Holly Bot. Your bots, chats and memories are safe in your account.", { plan: planName })
      : tr("Holly Bot couldn't renew your subscription. Update your payment method to keep using Holly Bot. Your bots, chats and memories are safe in your account.");
    const say = {
      past_due: [tr("Your payment didn't go through"), renew, tr('Update Payment Method')],
      unpaid: [tr("Your payment didn't go through"), renew, tr('Update Payment Method')],
      paused: [tr('Your subscription is paused'), planName
        ? tr('Resume your {plan} plan to keep using Holly Bot. Your bots, chats and memories are safe in your account.', { plan: planName })
        : tr('Resume your subscription to keep using Holly Bot. Your bots, chats and memories are safe in your account.'), tr('Manage Billing')],
      incomplete: [tr('Your payment is processing'), tr('Holly Bot opens as soon as Stripe confirms your payment.'), null],
    }[sub.status] || [tr('Checking your subscription'), planName
      ? tr("Holly Bot couldn't confirm your {plan} plan with Stripe just now. Check again in a minute.", { plan: planName })
      : tr("Holly Bot couldn't confirm your subscription with Stripe just now. Check again in a minute."), null];
    const [title, text, fix] = say;
    return html`
      <div class="hello">
        <div class="hello-canvas">
          <div class="hello-hero device">
            <${Avatar} shape="cloud" color="blue" size=${72} expression="sleepy" />
            <h1 class="device-title">${title}</h1>
            <p class="device-text">${text}</p>
            ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          </div>
          <div class="hello-dock">
            <div class="hello-ctas">
              ${fix && html`<button class="hello-cta" disabled=${!!busy} onClick=${manage}>${busy === 'billing' ? html`<span class="spinner"></span>` : fix}</button>`}
              <button class=${`hello-cta${fix ? ' secondary' : ''}`} disabled=${!!busy} onClick=${check}>${busy === 'check' ? html`<span class="spinner"></span>` : tr('Check Again')}</button>
              ${!fix && html`<button class="hello-cta secondary" disabled=${!!busy} onClick=${manage}>${busy === 'billing' ? html`<span class="spinner"></span>` : tr('Manage Billing')}</button>`}
            </div>
            ${accountLinks}
          </div>
        </div>
      </div>`;
  }

  const plan = plans.find((p) => p.id === chosen) || plans[0];
  const percent = yearlyPercent(plans);
  const ended = sub?.status === 'canceled' && (sub.endsAt || sub.periodEnd);
  const notice = back === 'cancelled'
    ? tr('Checkout was cancelled, and nothing was charged.')
    : ended
      ? planName
        ? tr('Your {plan} plan ended on {date}. Your bots, chats and memories are still in your account: choose a plan to pick up where you left off.', { plan: planName, date: longDate(sub.endsAt || sub.periodEnd) })
        : tr('Your subscription ended on {date}. Your bots, chats and memories are still in your account: choose a plan to pick up where you left off.', { date: longDate(sub.endsAt || sub.periodEnd) })
      : null;

  return html`
    <div class="hello">
      <div class="hello-canvas sub-canvas">
        <header class="sub-head">
          <${Avatar} shape="cloud" color="blue" size=${64} live />
          <h1 class="sub-title">${tr('Choose your plan')}</h1>
          <p class="sub-lead">${tr('Every plan runs your bots on a dedicated server of their own, set up for you as soon as you subscribe.')}</p>
        </header>
        ${notice && html`<p class="sub-notice" role="status">${notice}</p>`}

        <div class=${`sub-cycle ${every}`} role="radiogroup" aria-label=${tr('Billing')}>
          ${Object.entries(EVERY).map(([id, label]) => html`
            <label key=${id} class=${every === id ? 'on' : ''}>
              <input type="radio" name="every" value=${id} checked=${every === id} onChange=${() => setEvery(id)} />
              <span>${tr(label)}</span>
              ${id === 'year' && percent > 0 && html`<span class="sub-free">${tr('Save {percent}%', { percent })}</span>`}
            </label>`)}
        </div>

        <div class="sub-plans" role="radiogroup" aria-label=${tr('Plan')}>
          ${plans.map((p, i) => html`
            <label key=${p.id} class=${`sub-plan${p.id === plan?.id ? ' on' : ''}`} style=${`--i:${i}`}>
              <input type="radio" name="plan" value=${p.id} checked=${p.id === plan?.id} onChange=${() => setChosen(p.id)} />
              <span class="sub-radio" aria-hidden="true"><${Icon.check} size=${14} sw=${3.2} /></span>
              <span class="sub-name">
                ${p.name}
                ${every === 'year' && yearlySaving(p) > 0 && html`<span class="sub-save">${tr('Save {amount}', { amount: money(yearlySaving(p)) })}</span>`}
              </span>
              ${p.note && html`<span class="sub-note">${p.note}</span>`}
              <span class="sub-price" key=${every}>
                <b>${money(p.price[every])}</b>
                <span>${every === 'year' ? tr('/year') : tr('/month')}</span>
                ${every === 'year' && html`<span>${tr('{price} a month', { price: money(Math.round(p.price.year / 12)) })}</span>`}
              </span>
              <span class="sub-specs">
                <span><${Icon.cpu} size=${15} /> ${tr('{count} CPU', { count: p.cpu })}</span>
                <span><${Icon.memory} size=${15} /> ${tr('{size} GB RAM', { size: p.memoryGb })}</span>
                ${p.credits > 0 && html`<span><${Icon.sparkle} size=${15} /> ${tr('{count} AI credits a month', { count: number(p.credits) })}</span>`}
              </span>
            </label>`)}
        </div>

        <section class="sub-includes">
          <h2>${tr('Every plan includes')}</h2>
          <ul>
            <li><${Icon.bot} size=${18} /><span>${tr('Your bots, chats and memories in your account, on every device')}</span></li>
            <li><${Icon.brain} size=${18} /><span>${tr("Holly Bot's AI, DeepSeek, with AI credits that refill every month")}</span></li>
            <li><${Icon.mail} size=${18} /><span>${tr('Gmail, Outlook and GitHub for your bots to use')}</span></li>
            <li><${Icon.check} size=${18} /><span>${tr('Cancel anytime in Settings')}</span></li>
          </ul>
        </section>

        ${accountLinks}
        <p class="auth-legal sub-legal">
          <a href="terms.html" target="_blank" rel="noopener">${tr('Terms of Service')}</a> · <a href="privacy.html" target="_blank" rel="noopener">${tr('Privacy Policy')}</a>
        </p>

        <div class="sub-dock">
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          ${!status.ready && html`<p class="sub-fine">${tr("Subscriptions aren't set up on Holly Bot's server yet.")}</p>`}
          <button class="hello-cta" disabled=${!!busy || !status.ready || !plan} onClick=${subscribe}>
            ${busy === 'checkout' ? html`<span class="spinner"></span>` : plan
              ? every === 'year' ? tr('Subscribe for {price}/year', { price: money(plan.price[every]) }) : tr('Subscribe for {price}/month', { price: money(plan.price[every]) })
              : tr('Subscribe')}
          </button>
          <p class="sub-fine">${every === 'year'
            ? tr('Paid yearly, and renews every year until you cancel. Secure checkout with Stripe.')
            : tr('Month to month, and renews every month until you cancel. Secure checkout with Stripe.')}</p>
        </div>
      </div>
    </div>`;
}

/** Who is signed in, with Sign Out: before the app opens, Settings (where it
 * usually is) can't be reached. */
export function AccountLinks({ busy, onSignOut }) {
  const who = account.user?.email || account.user?.name || '';
  return html`
    <div class="sub-account">
      ${who && html`<p>${trx('Signed in as **{who}**', { who })}</p>`}
      <div class="sub-account-actions">
        <button disabled=${busy} onClick=${onSignOut}>${tr('Sign Out')}</button>
      </div>
    </div>`;
}
