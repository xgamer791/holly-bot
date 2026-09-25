import { html, useEffect, useState } from '../../vendor/preact.js';
import { account } from '../account/account.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';
import { AccountLinks } from './subscribe.js';

// "Setting up your computer…". Every subscriber gets their own server, made at
// Vultr with Holly installed on it the moment they subscribe
// (convex/servers.ts), which takes a few minutes. src/main.js shows this once
// the subscription is active and until the server is ready. It follows along
// live (billing:status every few seconds), opens the app when the server is
// ready, and when setting it up fails, says why and offers to try again
// (servers:retry, which schedules it; the app can't make servers itself).

const POLL_MS = 3000;
/** Setup that hasn't started after this long (Stripe's word hasn't come):
 * offer to start it. */
const NUDGE_MS = 90_000;
const SUPPORT = 'chris@mangomarketeers.com';

const STEPS = ['Subscription active', 'Creating your server', 'Starting it up', 'Installing Holly'];

/** Which step the server is on: 1 to 3, or STEPS.length when it's done. */
function stepOf(server) {
  if (server && ['ready', 'resizing'].includes(server.status)) return STEPS.length;
  if (server?.status !== 'provisioning') return 1;
  return { creating: 1, starting: 2, installing: 3 }[server.step] ?? 1;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `status` is billing:status; `onReady` opens the app. */
export function SetupScreen({ status: first, onReady, onSignOut }) {
  const [status, setStatus] = useState(first);
  const [now, setNow] = useState(Date.now());
  const [opened, setOpened] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let stopped = false;
    (async () => {
      while (!stopped) {
        await sleep(POLL_MS);
        if (stopped) return;
        try {
          const next = await account.authed('query', 'billing:status');
          if (stopped) return;
          // The subscription ended meanwhile: back to the subscription page.
          if (!next.active) return location.reload();
          setStatus(next);
          if (next.exempt || next.pastDue || ['ready', 'resizing'].includes(next.server?.status)) return onReady(next);
        } catch { /* offline for a moment: ask again */ }
      }
    })();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearInterval(tick);
    };
  }, []);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await account.authed('mutation', 'servers:retry');
      setStatus((s) => ({ ...s, server: { status: 'none' } }));
      setOpened(Date.now());
    } catch (err) {
      setError(typeof err?.data === 'string' ? err.data : "Couldn't start again. Check your connection and try again.");
    }
    setBusy(false);
  };

  const server = status.server;
  const plan = status.plans?.find((p) => p.id === status.subscription?.plan);
  const links = html`<${AccountLinks} busy=${busy} onSignOut=${onSignOut} />`;

  if (server?.status === 'error') {
    return html`
      <div class="hello">
        <div class="hello-canvas">
          <div class="hello-hero device">
            <${Avatar} shape="cloud" color="blue" eyeColor="#ffffff" size=${72} expression="sleepy" />
            <h1 class="device-title">Your computer couldn't be set up</h1>
            <p class="device-text">${server.error || 'Something went wrong while setting it up.'}</p>
            <p class="device-text">Your subscription is active and nothing is lost. Try again, and if it keeps happening, write to <a href=${`mailto:${SUPPORT}`}>${SUPPORT}</a>.</p>
            ${error && html`<p class="auth-error" role="alert">${error}</p>`}
          </div>
          <div class="hello-dock">
            <div class="hello-ctas">
              <button class="hello-cta" disabled=${busy} onClick=${retry}>${busy ? html`<span class="spinner"></span>` : 'Try Again'}</button>
            </div>
            ${links}
          </div>
        </div>
      </div>`;
  }

  const at = stepOf(server);
  const since = server?.since ?? opened;
  const waitingToStart = (!server || server.status === 'none') && now - opened > NUDGE_MS;
  return html`
    <div class="hello">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape="cloud" color="blue" eyeColor="#ffffff" size=${72} activity="working" />
          <h1 class="device-title">Setting up your computer…</h1>
          <p class="device-text">${plan ? `Your own server, with ${plan.cpu} CPU and ${plan.memoryGb} GB RAM, in Chicago.` : 'Your own server, in Chicago.'} It takes a few minutes, and carries on if you close Holly Bot.</p>
          <ol class="setup-steps" aria-label="Progress">
            ${STEPS.map((label, i) => html`
              <li key=${label} class=${i < at ? 'done' : i === at ? 'now' : ''} aria-current=${i === at ? 'step' : undefined}>
                <span class="setup-dot" aria-hidden="true">${i < at ? html`<${Icon.check} size=${13} sw=${3.2} />` : i === at ? html`<span class="spinner"></span>` : ''}</span>
                <span>${i === 1 && server?.status === 'deleting' ? 'Clearing away the last try' : label}</span>
              </li>`)}
          </ol>
          <p class="setup-time" role="timer">${clock(now - since)}</p>
          ${waitingToStart && html`<button class="auth-skip" disabled=${busy} onClick=${retry}>Setup hasn't started. Start it now</button>`}
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
        </div>
        <div class="hello-dock">${links}</div>
      </div>
    </div>`;
}
