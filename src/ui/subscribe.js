import { html, useEffect, useState } from '../../vendor/preact.js';
import { account } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';
import { dateText, mark, number, tr, trx } from './i18n.js';

// The plan page, on the same white page as signing in. Every account starts
// on Free (convex/lib/plans.ts FREE), and this is where it upgrades: a new
// account comes here first, before its first bot, and picks a plan or Free
// (src/main.js showPlans); Upgrade Plan at the top of Settings opens it over
// the app (PlansPage), and so do the notes that say a paid plan would do
// more. Plans are the server's, paid month to month or, for less, yearly,
// through Stripe Checkout (convex/billing.ts). Back from paying, src/main.js
// shows it while it waits for Stripe's word, then opens the app, while the
// subscriber's computer is set up. On a paid plan it shows the plan, and
// Manage Billing leads to Stripe's billing portal; so does a payment that
// didn't go through.

const EVERY = { month: mark('Monthly'), year: mark('Yearly') };
/** A subscription in one of these needs something done before Holli Bot opens. */
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
  if (err?.name === 'TypeError') return tr("Couldn't reach Holli Bot's server. Check your connection and try again.");
  return fallback;
}

/** Where Stripe sends people back to: this page's address, which the server
 * checks against the places Holli Bot may return to (convex/auth.ts). */
const here = () => `${location.origin}${location.pathname}`;

/**
 * `status` is billing:status. `back` says what the person just came back
 * from: 'paid' (Checkout), 'cancelled' (left Checkout), 'billing' (the portal)
 * or null. `onActive` opens the app once the subscription is active, and
 * `onFree` opens it on Free while Stripe takes its time. `start`: it's the
 * account's first stop, before its first bot, and `onFree` goes on with Free.
 * `onClose`: it's open over the app (PlansPage), which it goes back to.
 */
export function SubscribeScreen({ status: first, back, start, onActive, onFree, onSignOut, onClose }) {
  const [status, setStatus] = useState(first);
  const sub = status.subscription;
  const plans = status.plans || [];
  // On a paid plan now (past due included): the page shows it, and Stripe changes it.
  const paid = !!status.active && !status.exempt && !!sub;
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
  // Before the first bot, Free is one of the choices.
  const freeNow = !!start && !!onFree && status.free;
  // Over the app, Settings has Sign Out: none here, and a way back instead.
  const accountLinks = !onClose && html`<${AccountLinks} busy=${!!busy} onSignOut=${onSignOut} />`;
  const page = `hello${onClose ? ' in-app' : ''}`;
  const close = onClose && html`<button class="sub-close" aria-label=${tr('Close')} disabled=${busy === 'checkout' || busy === 'billing'} onClick=${onClose}><${Icon.x} size=${20} /></button>`;

  if (waiting) {
    return html`
      <div class=${page}>
        ${close}
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
                ${onFree && status.free && html`<button class="hello-cta secondary" disabled=${!!busy} onClick=${() => onFree(status)}>${tr('Use Free for Now')}</button>`}
              </div>
              ${accountLinks}
            </div>`}
        </div>
      </div>`;
  }

  // A subscription that isn't over but doesn't pay for Holli Bot right now
  // (a renewal that didn't go through, a payment still processing, paused),
  // or one Stripe hasn't confirmed lately: the account is on Free meanwhile,
  // and it's sorted out in Stripe's portal, not with a second subscription.
  const stale = sub && ['active', 'trialing'].includes(sub.status);
  if (sub && !paid && (NEEDS.includes(sub.status) || stale)) {
    const renew = planName
      ? tr("Holli Bot couldn't renew your {plan} plan. Update your payment method to get it back; meanwhile you're on Free. Your bots, chats and memories are safe in your account.", { plan: planName })
      : tr("Holli Bot couldn't renew your subscription. Update your payment method to get it back; meanwhile you're on Free. Your bots, chats and memories are safe in your account.");
    const say = {
      past_due: [tr("Your payment didn't go through"), renew, tr('Update Payment Method')],
      unpaid: [tr("Your payment didn't go through"), renew, tr('Update Payment Method')],
      paused: [tr('Your subscription is paused'), planName
        ? tr("Resume your {plan} plan to get it back; meanwhile you're on Free. Your bots, chats and memories are safe in your account.", { plan: planName })
        : tr("Resume your subscription to get it back; meanwhile you're on Free. Your bots, chats and memories are safe in your account."), tr('Manage Billing')],
      incomplete: [tr('Your payment is processing'), tr('Your plan starts as soon as Stripe confirms your payment.'), null],
    }[sub.status] || [tr('Checking your subscription'), planName
      ? tr("Holli Bot couldn't confirm your {plan} plan with Stripe just now. Check again in a minute.", { plan: planName })
      : tr("Holli Bot couldn't confirm your subscription with Stripe just now. Check again in a minute."), null];
    const [title, text, fix] = say;
    return html`
      <div class=${page}>
        ${close}
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
              ${freeNow && html`<button class="hello-cta secondary" disabled=${!!busy} onClick=${() => onFree(status)}>${tr('Use Free for Now')}</button>`}
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
    : paid && status.pastDue
      ? tr("Your payment didn't go through")
      : ended
        ? planName
          ? tr('Your {plan} plan ended on {date}. Your bots, chats and memories are still in your account: choose a plan to pick up where you left off.', { plan: planName, date: longDate(sub.endsAt || sub.periodEnd) })
          : tr('Your subscription ended on {date}. Your bots, chats and memories are still in your account: choose a plan to pick up where you left off.', { date: longDate(sub.endsAt || sub.periodEnd) })
        : null;
  // At the top: the plan it's on, or on Free, what a plan adds.
  const title = paid ? tr('Your plan') : status.free && !freeNow ? tr('Upgrade your plan') : tr('Choose your plan');
  const lead = paid
    ? tr('Change your plan, update your card, see invoices or cancel on Stripe.')
    : freeNow
      ? tr('Start on Free, with {count} AI credits a day, or choose a plan: each adds a dedicated server that runs your bots around the clock, DeepSeek V4 Pro and more AI credits.', { count: number(status.freeCredits) })
      : status.free
        ? tr("You're on Free, with {count} AI credits a day. Every plan adds a dedicated server that runs your bots around the clock, DeepSeek V4 Pro and more AI credits.", { count: number(status.freeCredits) })
        : tr('Every plan runs your bots on a dedicated server of their own, set up for you as soon as you subscribe.');
  const renewal = paid && (sub.endsAt
    ? tr("Your plan ends on {date}. Then you're on Free.", { date: longDate(sub.endsAt) })
    : sub.periodEnd ? tr('Renews on {date}.', { date: longDate(sub.periodEnd) }) : '');

  return html`
    <div class=${page}>
      ${close}
      <div class="hello-canvas sub-canvas">
        <header class="sub-head">
          <${Avatar} shape="cloud" color="blue" size=${64} live />
          <h1 class="sub-title">${title}</h1>
          <p class="sub-lead">${lead}</p>
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
            <label key=${p.id} class=${`sub-plan${p.id === plan?.id ? ' on' : ''}${paid ? ' fixed' : ''}`} style=${`--i:${i}`}>
              <input type="radio" name="plan" value=${p.id} checked=${p.id === plan?.id} disabled=${paid} onChange=${() => setChosen(p.id)} />
              <span class="sub-radio" aria-hidden="true"><${Icon.check} size=${14} sw=${3.2} /></span>
              <span class="sub-name">
                ${p.name}
                ${paid && p.id === sub.plan && html`<span class="sub-now">${tr('Current plan')}</span>`}
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
            <li><${Icon.server} size=${18} /><span>${tr('Your own server, running your bots around the clock')}</span></li>
            <li><${Icon.brain} size=${18} /><span>${tr("Holli Bot's AI, DeepSeek, with AI credits that refill every month")}</span></li>
            <li><${Icon.sparkle} size=${18} /><span>${tr('DeepSeek V4 Pro, for deeper thinking')}</span></li>
            <li><${Icon.bot} size=${18} /><span>${tr('Your bots, chats and memories in your account, on every device')}</span></li>
            <li><${Icon.check} size=${18} /><span>${tr('Cancel anytime in Settings')}</span></li>
          </ul>
        </section>

        ${accountLinks}
        <p class="auth-legal sub-legal">
          <a href="terms.html" target="_blank" rel="noopener">${tr('Terms of Service')}</a> · <a href="privacy.html" target="_blank" rel="noopener">${tr('Privacy Policy')}</a>
        </p>

        <div class="sub-dock">
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          ${paid ? html`
            <button class="hello-cta" disabled=${!!busy} onClick=${manage}>${busy === 'billing' ? html`<span class="spinner"></span>` : tr('Manage Billing')}</button>
            ${renewal && html`<p class="sub-fine">${renewal}</p>`}`
          : html`
            ${!status.ready && html`<p class="sub-fine">${tr("Subscriptions aren't set up on Holli Bot's server yet.")}</p>`}
            <button class="hello-cta" disabled=${!!busy || !status.ready || !plan} onClick=${subscribe}>
              ${busy === 'checkout' ? html`<span class="spinner"></span>` : plan
                ? every === 'year' ? tr('Subscribe for {price}/year', { price: money(plan.price[every]) }) : tr('Subscribe for {price}/month', { price: money(plan.price[every]) })
                : tr('Subscribe')}
            </button>
            <p class="sub-fine">${every === 'year'
              ? tr('Paid yearly, and renews every year until you cancel. Secure checkout with Stripe.')
              : tr('Month to month, and renews every month until you cancel. Secure checkout with Stripe.')}</p>
            ${freeNow && html`<button class="hello-cta secondary" disabled=${!!busy} onClick=${() => onFree(status)}>${tr('Continue with Free')}</button>`}`}
        </div>
      </div>
    </div>`;
}

/**
 * The plan page over the app: Upgrade Plan at the top of Settings, Plan on a
 * paid plan, and the notes that say a paid plan would do more (src/ui/
 * settings.js, message.js, bot-profile.js, computer.js). It asks for the
 * account's plan as it opens. Checkout leaves for Stripe, which comes back to
 * the app (src/main.js); the white page takes the status bar's color while
 * it's open.
 */
export function PlansPage({ onClose }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const before = meta?.getAttribute('content');
    meta?.setAttribute('content', '#ffffff');
    let alive = true;
    account.authed('query', 'billing:status')
      .then((next) => alive && setStatus(next))
      .catch((err) => alive && setError(serverSays(err, tr('Something went wrong. Please try again.'))));
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => {
      alive = false;
      removeEventListener('keydown', onKey);
      if (before) meta?.setAttribute('content', before);
    };
  }, []);
  if (status) return html`<${SubscribeScreen} status=${status} back=${null} onClose=${onClose} onActive=${() => location.reload()} />`;
  return html`
    <div class="hello in-app">
      <button class="sub-close" aria-label=${tr('Close')} onClick=${onClose}><${Icon.x} size=${20} /></button>
      <div class="hello-canvas">
        <div class="hello-hero device">
          ${error ? html`<p class="auth-error" role="alert">${error}</p>` : html`<span class="spinner" role="status" aria-label=${tr('Loading')}></span>`}
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
