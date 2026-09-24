import { html, useState, useEffect } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useAsync } from './hooks.js';
import { Sheet, Group, Row, Field, Toggle, downloadBlob } from './components.js';
import { Icon } from './icons.js';
import { Avatar } from './avatar.js';
import { PROVIDERS, PROVIDER_ORDER } from '../core/providers/index.js';
import { formatShort, initials } from '../core/util.js';
import { APP_NAME, APP_VERSION } from '../core/constants.js';
import { estimateCost, totalCost, deepseekPeak } from '../core/pricing.js';
import { voices } from './speech.js';
import { modelsFor } from './bot-profile.js';
import {
  RemoteApp, computerConnection, computerState, runHere, savedConnection, saveConnection,
} from '../remote/remote-app.js';
import { account, noticeAfterReload, signInWorksHere, takeNotice, SITE } from '../account/account.js';
import { longDate } from './subscribe.js';

const APPEARANCE = { system: 'System · Black', black: 'Black', dark: 'Dark', light: 'Light' };
const SIGN_IN_WITH = { apple: 'Apple', google: 'Google' };

/** The Holly Bot account, re-rendering when it changes and refreshing who is
 * signed in from the database each time Settings opens. */
function useAccount() {
  const [, setTick] = useState(0);
  const here = signInWorksHere();
  useEffect(() => {
    const off = account.on(() => setTick((n) => n + 1));
    if (here && account.signedIn) account.refreshUser().catch((err) => console.warn('account', err));
    return off;
  }, []);
  return { signedIn: here && account.signedIn, user: account.user };
}

/** Where this app keeps bots, chats and keys, for the wording around Settings. */
function home(app) {
  if (app.remote) return { in: 'on your computer', from: 'from your computer' };
  if (app.db?.cloud) return { in: 'in your account', from: 'from your account' };
  return { in: 'in this browser', from: 'from this browser' };
}

/** Who is signed in. Where there are no accounts (Holly Computer's Wi-Fi
 * links, browser automation) it doesn't show. */
function AccountGroup({ acct }) {
  if (!acct.signedIn) return null;
  const user = acct.user || {};
  const via = (user.providers || []).map((p) => SIGN_IN_WITH[p] || p).join(' and ');
  const detail = [user.name && user.email, via && `Signed in with ${via}`].filter(Boolean).join(' · ');
  return html`<${Group}>
    <div class="row">
      <span class="initials">${initials(user.name || user.email)}</span>
      <div class="label"><div class="t">${user.name || user.email || 'Holly Bot account'}</div><div class="s">${detail || 'Signed in'}</div></div>
    </div>
  <//>`;
}

const SERVER_STATUS = { none: 'Not set up', provisioning: 'Setting up', ready: 'Ready', resizing: 'Changing size', deleting: 'Deleting', error: "Couldn't set up" };

/** The account's plan, and its own computer (convex/servers.ts). Tapping the
 * plan opens Stripe's billing portal to change it, update the card, see
 * invoices or cancel (convex/billing.ts); coming back, the app checks the
 * subscription again (src/main.js). A computer that couldn't be set up can be
 * tried again. */
function SubscriptionGroup({ acct }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const { data: status, reload } = useAsync(() => (acct.signedIn ? account.authed('query', 'billing:status') : Promise.resolve(null)), [acct.signedIn]);
  if (!acct.signedIn) return null;
  const server = status?.server;
  const size = status?.plans?.find((p) => p.id === server?.plan);
  const retry = async () => {
    try {
      await account.authed('mutation', 'servers:retry');
      ui.toast('Setting up your computer again. It takes a few minutes.');
      reload();
    } catch (err) {
      ui.toast(serverSays(err, "Couldn't start again. Check your connection and try again."), { error: true });
    }
  };
  const computer = server && server.status !== 'none' && html`<${Row} title="Your computer" value=${SERVER_STATUS[server.status] || server.status}
    sub=${server.error || [size && `${size.cpu} CPU, ${size.memoryGb} GB RAM`, server.ip].filter(Boolean).join(' · ') || null}
    onClick=${server.status === 'error' ? retry : null} />`;
  const sub = status?.subscription;
  // An account that needs no subscription (the owner's, while testing).
  if (status?.exempt && !sub) {
    return html`<${Group}>
      <${Row} title="Subscription" value="Not needed" sub="This account uses Holly Bot without a plan while it's being tested." />
    <//>`;
  }
  const plan = status?.plans?.find((p) => p.id === sub?.plan);
  const when = sub?.endsAt ? `Ends ${longDate(sub.endsAt)}` : sub?.periodEnd ? `Renews ${longDate(sub.periodEnd)}` : '';
  const detail = [{ month: 'Monthly', year: 'Yearly' }[sub?.interval], when].filter(Boolean).join(' · ');
  const manage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      location.assign(await account.authed('action', 'billing:portal', { returnTo: `${location.origin}${location.pathname}` }));
    } catch (err) {
      setBusy(false);
      ui.toast(serverSays(err, "Couldn't open billing. Check your connection and try again."), { error: true });
    }
  };
  return html`<${Group} note="Change your plan, update your card, see invoices or cancel, on Stripe.">
    <${Row} title="Subscription" sub=${status?.pastDue ? "Your last payment didn't go through. Tap to update your card." : detail} value=${busy ? html`<span class="spinner"></span>` : plan ? `Holly Bot ${plan.name}` : ''} danger=${!!status?.pastDue} onClick=${manage} />
    ${computer}
  <//>`;
}


export function SettingsSheet({ onClose, page: initialPage, provider: initialProvider }) {
  const app = useApp();
  useTopics(['settings', 'computer', 'plugins', 'agents']);
  const [stack, setStack] = useState(() => (initialPage ? [{ page: initialPage, provider: initialProvider }] : []));
  const top = stack[stack.length - 1];
  const go = (page, extra = {}) => setStack([...stack, { page, ...extra }]);
  const back = () => setStack(stack.slice(0, -1));
  const titles = {
    profile: 'Profile', usage: 'Usage', keys: 'API Keys', provider: PROVIDERS[top?.provider]?.label || 'Provider', plugins: 'Plugins',
    computer: 'Bot Computer', appearance: 'Appearance', language: 'Language', haptics: 'Haptics', timezone: 'Time Zone', data: 'Data & Backup',
    memory: 'Memory & Context', help: 'Help Center', privacy: 'Privacy Policy', terms: 'Terms of Service', voice: 'Voice',
  };
  const left = top
    ? html`<button class="circle-btn" aria-label="Back" onClick=${back}><${Icon.back} /></button>`
    : html`<button class="circle-btn" aria-label="Close" onClick=${onClose}><${Icon.x} /></button>`;
  const pages = {
    profile: ProfilePage, usage: UsagePage, keys: KeysPage, provider: ProviderPage, plugins: PluginsPage, computer: ComputerPage,
    appearance: AppearancePage, language: LanguagePage, haptics: HapticsPage, timezone: TimeZonePage, data: DataPage, memory: MemorySettingsPage,
    help: HelpPage, privacy: PrivacyPage, terms: TermsPage, voice: VoicePage,
  };
  const Page = top ? pages[top.page] : MainPage;
  return html`<${Sheet} title=${top ? titles[top.page] : ''} left=${left} onClose=${onClose}>
    <${Page} go=${go} back=${back} onClose=${onClose} ...${top || {}} />
  <//>`;
}

function MainPage({ go, onClose }) {
  const app = useApp();
  const ui = useUi();
  const acct = useAccount();
  const s = app.settings;
  const ready = app.providers.readyProviders();
  const cost = totalCost(s);
  const tz = app.timeZone();
  const set = (patch) => app.saveSettings(patch);
  return html`
    <${AccountGroup} acct=${acct} />
    <${SubscriptionGroup} acct=${acct} />
    <${Group}>
      <button class="row" onClick=${() => go('profile')}>
        <span class="initials">${s.profile?.name ? initials(s.profile.name) : '?'}</span>
        <div class="label"><div class="t">${s.profile?.name || 'Your profile'}</div><div class="s">${s.profile?.email || 'Add your name so bots know you'}</div></div>
        <${Icon.chevron} class="chev" />
      </button>
      <${Row} title="Usage" value=${cost != null ? `$${cost.toFixed(cost < 1 ? 3 : 2)}` : '—'} onClick=${() => go('usage')} />
    <//>
    <${Group}>
      <${Row} title="API Keys" sub=${ready.length ? `Bring your own key · ${ready.map((id) => PROVIDERS[id].label.split(' ')[0]).join(', ')}` : 'Bring your own key — add one to start'} onClick=${() => go('keys')} />
      <${Row} title="Plugins" sub="Gmail, Outlook, GitHub, tools and skills" onClick=${() => go('plugins')} />
    <//>
    <div class="group-label">Bot</div>
    <${Group}>
      <${Row} title="Auto-review" sub="Require approval for risky shell, MCP, and computer actions, sending or deleting email, and publishing repositories." toggle=${s.autoReview !== false} onToggle=${(v) => set({ autoReview: v })} />
      <${Row} title="Set Time Zone Automatically" sub="Your Bot's computer follows this device's time zone." toggle=${s.timeZoneAuto !== false}
        onToggle=${(v) => set({ timeZoneAuto: v, timeZone: v ? '' : tz })} />
      <${Row} title="Time Zone" value=${tz} onClick=${s.timeZoneAuto === false ? () => go('timezone') : null} chevron=${false} />
      <${Row} title="Bot Computer" value=${app.remote ? app.computer.info?.hostname || 'Connected' : app.linkedComputers?.length ? 'Not connected' : 'Set up'} onClick=${() => go('computer')} />
      <${Row} title="Memory & Context" onClick=${() => go('memory')} />
      <${Row} title="Routines" onClick=${() => ui.openSheet('routines', {})} />
    <//>
    <${Group}>
      <${Row} title="Notifications" toggle=${!!s.notifications} onToggle=${async (v) => {
        if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
          const p = await Notification.requestPermission().catch(() => 'denied');
          if (p !== 'granted') {
            ui.toast('Notifications are blocked for this site. On iPhone, add Holly Bot to your Home Screen first.', { error: true });
            return;
          }
        }
        set({ notifications: v });
      }} />
      <${Row} title="Appearance" value=${APPEARANCE[s.appearance] || APPEARANCE.system} onClick=${() => go('appearance')} />
      <${Row} title="Language" value=${s.language === 'en' ? 'English' : 'System'} onClick=${() => go('language')} />
      <${Row} title="Haptics" value=${s.haptics ? 'On' : 'Off'} onClick=${() => go('haptics')} />
      <${Row} title="Voice" value=${s.voice?.name ? s.voice.name.split(' ')[0] : 'Default'} onClick=${() => go('voice')} />
    <//>
    <${Group}>
      <${Row} title="Data & Backup" onClick=${() => go('data')} />
    <//>
    <${Group}>
      <${Row} title="Help Center" onClick=${() => go('help')} />
      <${Row} title="Privacy Policy" onClick=${() => go('privacy')} />
      <${Row} title="Terms of Service" onClick=${() => go('terms')} />
    <//>
    <${Group}>
      <${Row} title="Send Feedback" onClick=${() => window.open('https://github.com/xgamer791/holly-bot/issues/new', '_blank', 'noopener')} />
    <//>
    <${Group}>
      ${acct.signedIn ? html`
        <${Row} title="Sign Out" sub=${app.remote ? 'Your bots stay on your computer.' : 'Your bots, chats, memories and keys stay in your account.'} danger onClick=${() => signOut(app, ui)} />
        <${Row} title="Delete Account" sub="Permanently deletes your account and everything in it." danger onClick=${() => deleteAccount(app, ui)} />`
      : html`<${Row} title="Sign Out" sub="Removes your API keys from this device. Bots and memories stay." danger onClick=${async () => {
        if (!(await ui.confirm({ title: 'Sign out?', message: 'Your API keys will be removed. Your bots, chats and memories are kept.', confirmText: 'Sign Out', danger: true }))) return;
        const providers = {};
        for (const [id, p] of Object.entries(s.providers || {})) providers[id] = { ...p, apiKey: '' };
        const services = {};
        for (const [id, p] of Object.entries(s.services || {})) services[id] = { ...p, apiKey: '' };
        await set({ providers, services, computer: { url: s.computer?.url || '', token: '' } });
        app.computer.connected = false;
        ui.toast('Signed out — keys removed');
        onClose();
      }} />`}
    <//>
    <div class="footer-brand">
      <${Avatar} shape="circle" color="white" size=${84} expression="upRight" />
      <div class="n">${APP_NAME}</div>
      <div class="v">${APP_VERSION} · bring your own key</div>
    </div>`;
}

/** Signs out of the account, leaving nothing of it on this device: unsent
 * changes go up first (for a few seconds), and the link to a Holly Computer is
 * forgotten here (signing in again finds one linked to the account; one that
 * isn't needs its link opened again). */
async function signOut(app, ui) {
  const name = app.server?.name || 'your computer';
  const message = app.remote && app.server?.account?.linked
    ? `You'll be back at the welcome screen. Your bots stay in your account and ${name} keeps running them. Sign in again and this device connects to it by itself.`
    : app.remote
      ? "You'll be back at the welcome screen, and this device forgets your Holly Computer until you open its link again. Your bots stay on the computer."
      : "You'll be back at the welcome screen. Your bots, chats, memories and API keys stay in your account for when you sign in again.";
  if (!(await ui.confirm({ title: 'Sign out?', message, confirmText: 'Sign Out', danger: true }))) return;
  ui.toast('Signing out…');
  if (!app.remote) {
    app.stopScheduler();
    app.runtime.stopAll();
  }
  await app.db?.close?.({ forget: true });
  saveConnection(null);
  await account.signOut(); // src/main.js reloads into the welcome screen
}

/**
 * Settings → Delete Account (App Store guideline 5.1.1(v)): erases the account
 * and everything in it on Holly Bot's server (convex/account.ts), and what
 * this device kept for it. Storage stops first, so nothing is written after.
 */
async function deleteAccount(app, ui) {
  const computer = app.remote && !app.server?.account?.linked
    ? " Bots on your Holly Computer aren't part of your account: they stay on that computer until you delete them there."
    : '';
  if (!(await ui.confirm({
    title: 'Delete your account?',
    message: `This permanently deletes your Holly Bot account and everything in it: bots, chats, memories, files, routines, settings and API keys, and cancels your subscription right away. It can't be undone.${computer}`,
    confirmText: 'Delete Account',
    danger: true,
  }))) return;
  ui.toast('Deleting your account…');
  const conn = savedConnection();
  try {
    if (!app.remote) {
      app.stopScheduler();
      app.runtime.stopAll();
    }
    await app.db?.discard?.();
    saveConnection(null);
    noticeAfterReload('Your account and everything in it have been deleted.');
    await account.deleteAccount(); // src/main.js reloads into the welcome screen
  } catch (err) {
    console.error('delete account', err);
    takeNotice();
    if (conn) saveConnection(conn);
    ui.toast("Your account couldn't be deleted. Check your connection and try again.", { error: true });
    // This app stopped saving to the account; reload to start it again.
    if (app.db?.cloud) setTimeout(() => location.reload(), 4000);
  }
}

function ProfilePage() {
  const app = useApp();
  const p = app.settings.profile || {};
  const save = (patch) => app.saveSettings({ profile: { ...p, ...patch } });
  return html`
    <div class="create-preview" style="padding:10px 0 16px"><span class="initials" style="width:84px;height:84px;font-size:30px">${p.name ? initials(p.name) : '?'}</span></div>
    <${Group}>
      <div class="row"><div class="label"><div class="t">Name</div></div><input type="text" value=${p.name || ''} placeholder="Your name" onChange=${(e) => save({ name: e.currentTarget.value.trim() })} /></div>
      <div class="row"><div class="label"><div class="t">Email</div></div><input type="email" value=${p.email || ''} placeholder="Optional" onChange=${(e) => save({ email: e.currentTarget.value.trim() })} /></div>
    <//>
    <${Field} label="About you (shared with all your bots)" hint="Anything every bot should know: what you do, where you live, how you like answers.">
      <textarea class="textarea" value=${p.about || ''} placeholder="e.g. I run a hair studio in Austin, TX. I like short, direct answers." onChange=${(e) => save({ about: e.currentTarget.value })}></textarea>
    <//>`;
}

function UsagePage() {
  const app = useApp();
  const ui = useUi();
  const rows = Object.entries(app.settings.usage?.byModel || {}).sort((a, b) => (b[1].last || 0) - (a[1].last || 0));
  const cost = totalCost(app.settings);
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const hasDeepseek = app.providers.isReady('deepseek');
  const { data: balance } = useAsync(() => (hasDeepseek ? app.providers.balance('deepseek').catch(() => null) : null), [hasDeepseek]);
  return html`
    ${hasDeepseek && html`<${Group} label="DeepSeek account">
      <${Row} title="Balance" value=${balance?.length ? balance.map((b) => `${b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : `${b.currency} `}${b.total.toFixed(2)}`).join(' · ') : balance === null ? '—' : '…'} />
      <${Row} title="Price right now" sub="Off-peak is half price. Peak: 01–04 and 06–10 UTC on weekdays." value=${deepseekPeak() ? 'Peak' : 'Off-peak'} />
    <//>`}
    <p class="hint" style="font-size:14px;margin:4px">Tracked ${home(app).in} since ${app.settings.usage?.since ? new Date(app.settings.usage.since).toLocaleDateString() : 'first use'}. Costs are estimates from public list prices — your provider's dashboard is the source of truth.</p>
    <div class="group" style="padding:6px 14px">
      <table class="usage-table">
        <thead><tr><th>Model</th><th>Calls</th><th>In</th><th>Out</th><th>Est.</th></tr></thead>
        <tbody>${rows.map(([key, u]) => {
          const model = key.split(':').slice(1).join(':');
          const c = u.cost != null ? u.cost : estimateCost(model, u);
          return html`<tr key=${key}><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${model}<br /><small style="color:var(--muted)">${PROVIDERS[key.split(':')[0]]?.label || key.split(':')[0]}</small></td>
            <td>${u.calls}${u.images ? ` +${u.images}🖼` : ''}</td><td>${fmt(u.input)}</td><td>${fmt(u.output)}</td><td>${c != null ? `$${c.toFixed(3)}` : '—'}</td></tr>`;
        })}</tbody>
      </table>
      ${!rows.length && html`<p class="hint" style="padding:10px 0">No usage yet.</p>`}
    </div>
    <p style="text-align:center;font-size:20px;font-weight:600">${cost != null ? `≈ $${cost.toFixed(2)}` : ''}</p>
    <button class="btn block" onClick=${async () => {
      if (await ui.confirm({ title: 'Reset usage stats?', confirmText: 'Reset', danger: true })) app.saveSettings({ usage: { since: Date.now(), byModel: {} } });
    }}>Reset</button>`;
}

function KeysPage({ go }) {
  const app = useApp();
  const ui = useUi();
  const s = app.settings;
  const ready = app.providers.readyProviders();
  let defaultLabel = 'Not set';
  try {
    const cfg = app.providers.resolve(null);
    defaultLabel = `${cfg.model}`;
  } catch { /* none */ }
  return html`
    <p class="hint" style="font-size:14.5px;margin:2px 4px 6px">${app.remote
      ? html`Keys are stored on your computer (${app.computer.info?.hostname || 'Holly Computer'}) and never sent back to this device. Your bots call the providers from there.`
      : app.db?.cloud
        ? 'Your keys are kept in your Holly Bot account, and this app sends them straight to each provider when a bot works. Holly Bot never uses them for anything else.'
        : 'Your keys are stored only in this browser and sent straight to each provider.'} DeepSeek V4.1 Flash is the default for every bot; add others to give specific bots a different brain.</p>
    <${Group}>
      ${PROVIDER_ORDER.map((id) => {
        const p = PROVIDERS[id];
        const ok = app.providers.isReady(id);
        return html`<button key=${id} class="row" onClick=${() => go('provider', { provider: id })}>
          <span class="provider-logo">${p.label.slice(0, 1)}</span>
          <div class="label"><div class="t">${p.label}</div>${id === 'xai' && html`<div class="s">Grok models + live web & X search</div>`}</div>
          ${ok ? html`<span class="ok-check"><${Icon.check} /></span>` : html`<span class="value">Add</span>`}
          <${Icon.chevron} class="chev" />
        </button>`;
      })}
    <//>
    <div class="group-label">Defaults</div>
    <${Group}>
      <${Row} title="Default model" sub="Used by bots that don't pick their own" value=${defaultLabel} onClick=${() => (ready.length ? ui.openSheet('modelPicker', {}) : ui.toast('Add a key first'))} />
      <div class="row"><div class="label"><div class="t">Backup if it fails</div><div class="s">When the main provider is down, rate limited or out of credit, retry once with this</div></div>
        <select aria-label="Backup model" value=${s.backup?.provider ? `${s.backup.provider}:${s.backup.model || PROVIDERS[s.backup.provider]?.defaultModel || ''}` : ''}
          onChange=${(e) => {
            const [provider, ...rest] = e.currentTarget.value.split(':');
            app.saveSettings({ backup: { provider: provider || '', model: rest.join(':') } });
          }}>
          <option value="">Off</option>
          ${ready.flatMap((id) => modelsFor(app, id).slice(0, 6).map((m) => html`<option key=${`${id}:${m}`} value=${`${id}:${m}`}>${PROVIDERS[id].label.split(' ')[0]} · ${m}</option>`))}
        </select></div>
      <${Row} title="Memory & summaries model" sub="Runs memory extraction and summaries" value=${memoryModelLabel(s)} onClick=${() => go('memory')} />
      <div class="row"><div class="label"><div class="t">Image generation</div><div class="s">Provider for generate_image</div></div>
        <select value=${s.defaults?.imageProvider || ''} onChange=${(e) => app.saveSettings({ defaults: { ...s.defaults, imageProvider: e.currentTarget.value } })}>
          <option value="">Automatic</option>
          ${['xai', 'openai'].filter((id) => app.providers.isReady(id)).map((id) => html`<option value=${id}>${PROVIDERS[id].label}</option>`)}
        </select></div>
    <//>`;
}

function memoryModelLabel(s) {
  const mm = s.defaults?.memoryModel;
  if (!mm || mm === 'same') return 'Same as bot';
  return mm.split(':').slice(1).join(':') || mm;
}

function ProviderPage({ provider: id, back }) {
  const app = useApp();
  const ui = useUi();
  const def = PROVIDERS[id];
  const cur = app.settings.providers?.[id] || {};
  const [key, setKey] = useState(cur.apiKey || '');
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [adv, setAdv] = useState(!!(cur.baseURL || cur.proxy) || id === 'custom' || id === 'ollama');
  const save = (patch) => app.setProvider(id, patch);

  const test = async () => {
    await save({ apiKey: key.trim() });
    setTesting(true);
    setResult(null);
    try {
      const models = await app.providers.test(id);
      setResult({ ok: true, text: `Connected — ${models.length} models available.` });
      if (!app.settings.defaults?.provider) await app.saveSettings({ defaults: { ...app.settings.defaults, provider: id, model: def.defaultModel } });
      app.plugins.refresh().catch(() => {});
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setTesting(false);
    }
  };

  return html`
    ${def.noKey ? html`<${Group}><${Row} title="Enabled" toggle=${!!cur.enabled} onToggle=${(v) => save({ enabled: v })} /><//>
      <p class="hint" style="font-size:14px">Ollama must allow this site: set <span class="kbd">OLLAMA_ORIGINS=*</span> before <span class="kbd">ollama serve</span>. Works when this page and Ollama are on the same computer (or via a tunnel).</p>`
    : html`<${Field} label="API key" hint=${html`${app.remote ? 'Stored on your computer.' : app.db?.cloud ? 'Kept in your account.' : 'Stored only on this device.'} ${def.keyUrl ? html`<a href=${def.keyUrl} target="_blank" rel="noopener">Get a ${def.label} key ↗</a>` : ''}`}>
        <div style="display:flex;gap:8px">
          <input class="input mono" type=${show ? 'text' : 'password'} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=${def.keyHint || 'API key'} value=${key}
            onInput=${(e) => setKey(e.currentTarget.value)} onBlur=${() => key.trim() !== (cur.apiKey || '') && save({ apiKey: key.trim() })} />
          <button class="circle-btn" aria-label=${show ? 'Hide key' : 'Show key'} onClick=${() => setShow(!show)}>${show ? html`<${Icon.eyeOff} />` : html`<${Icon.eye} />`}</button>
        </div>
      <//>`}
    <button class="btn block primary" disabled=${testing || (!def.noKey && !key.trim())} onClick=${test}>${testing ? html`<span class="spinner"></span> Testing…` : 'Save & test connection'}</button>
    ${result && html`<p style=${`font-size:14.5px;color:${result.ok ? 'var(--green)' : 'var(--red)'};margin:10px 4px;line-height:1.4`}>${result.text}</p>`}
    ${app.providers.isReady(id) && html`
      <div class="group-label">Models</div>
      <div class="group">${modelsFor(app, id).slice(0, 14).map((m) => html`<${Row} key=${m} title=${m} sub=${m === def.defaultModel ? 'Recommended default' : ''}
        value=${app.settings.defaults?.provider === id && app.settings.defaults?.model === m ? 'Default' : ''}
        onClick=${() => app.saveSettings({ defaults: { ...app.settings.defaults, provider: id, model: m } }).then(() => ui.toast(`Default model: ${m}`))} chevron=${false} />`)}</div>
      <div class="group-note">Tap to make a model the default for bots that don't choose their own.</div>`}
    ${def.nativeTools?.length > 0 && html`<${Group}>
      <${Row} title="Built-in web search" sub=${id === 'xai' ? 'Grok searches the web and X itself (billed by xAI)' : 'The provider runs web search for the model (may be billed per search)'}
        toggle=${cur.nativeSearch !== false} onToggle=${(v) => save({ nativeSearch: v })} />
    <//>`}
    <button class="btn block" style="margin-top:8px" onClick=${() => setAdv(!adv)}>${adv ? 'Hide' : 'Show'} advanced</button>
    ${adv && html`
      <${Field} label="Base URL" hint=${`Default: ${def.baseURL || '(required)'}`}>
        <input class="input mono" value=${cur.baseURL || ''} placeholder=${def.baseURL || 'https://…/v1'} autocapitalize="off" onChange=${(e) => save({ baseURL: e.currentTarget.value.trim() })} />
      <//>
      <${Field} label="CORS proxy (optional)" hint="Only if this provider blocks browser requests. The provider URL is appended to the proxy, or replaces {url}. Your key passes through the proxy — use one you run yourself (see proxy/ in the repo).">
        <input class="input mono" value=${cur.proxy || ''} placeholder="https://my-proxy.example.workers.dev" autocapitalize="off" onChange=${(e) => save({ proxy: e.currentTarget.value.trim() })} />
      <//>
      ${def.image && html`<${Field} label="Image model"><input class="input mono" value=${cur.imageModel || ''} placeholder=${def.image.model} onChange=${(e) => save({ imageModel: e.currentTarget.value.trim() })} /><//>`}`}
    ${(cur.apiKey || cur.enabled) && html`<button class="btn block danger" style="margin-top:18px" onClick=${async () => {
      await save({ apiKey: '', enabled: false, models: [] });
      setKey('');
      ui.toast('Key removed');
      back();
    }}>Remove key</button>`}`;
}

function PluginsPage() {
  const app = useApp();
  const ui = useUi();
  const s = app.settings;
  const [adding, setAdding] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const servers = s.mcpServers || [];
  const state = app.plugins.list();
  const saveServers = async (list) => {
    await app.saveSettings({ mcpServers: list });
    app.plugins.refresh().catch(() => {});
  };
  const services = s.services || {};
  const setService = (id, apiKey) => app.saveSettings({ services: { ...services, [id]: { ...(services[id] || {}), apiKey } } });
  return html`
    <${ConnectedAccounts} />

    <div class="group-label">MCP servers</div>
    <div class="group">
      ${servers.map((srv) => {
        const st = state.find((x) => x.key === `direct:${srv.id}`);
        return html`<div class="row" key=${srv.id}>
          <${Icon.plug} size="20" />
          <div class="label"><div class="t">${srv.name}</div><div class="s">${st?.status === 'ok' ? `${st.tools.length} tools` : st?.status === 'error' ? `Error: ${st.error}` : srv.enabled === false ? 'Off' : 'Connecting…'}</div></div>
          <${Toggle} small on=${srv.enabled !== false} onChange=${(v) => saveServers(servers.map((x) => (x.id === srv.id ? { ...x, enabled: v } : x)))} label=${srv.name} />
          <button class="icon-btn" aria-label="Remove" onClick=${() => saveServers(servers.filter((x) => x.id !== srv.id))}><${Icon.trash} /></button>
        </div>`;
      })}
      ${state.filter((p) => p.via === 'computer').map((p) => html`<div class="row" key=${p.key}><${Icon.monitor} size="20" />
        <div class="label"><div class="t">${p.name}</div><div class="s">${p.status === 'ok' ? `${p.tools.length} tools · on Bot Computer` : p.error || p.status}</div></div></div>`)}
      <button class="row" onClick=${() => setAdding(!adding)}><${Icon.plus} size="20" /><div class="label"><div class="t">Add MCP server</div></div></button>
    </div>
    <div class="group-note">Remote MCP servers (Streamable HTTP) are called straight from your browser and must allow CORS. Local servers (stdio, e.g. Gmail, filesystem, GitHub) run on your Bot Computer via <span class="kbd">~/.holly/mcp.json</span>.</div>
    ${adding && html`<${AddServer} onCancel=${() => setAdding(false)} onSave=${async (srv) => {
      await saveServers([...servers, srv]);
      setAdding(false);
      ui.toast(`Added ${srv.name}`);
    }} />`}

    <div class="group-label">Search & reading</div>
    <div class="group">
      ${[['tavily', 'Tavily', 'Web search API'], ['exa', 'Exa', 'Neural web search'], ['jina', 'Jina', 'Reader & search (optional key)'], ['brave', 'Brave Search', 'Used through your Bot Computer']].map(([id, label, sub]) => html`
        <div class="row" key=${id}><div class="label"><div class="t">${label}</div><div class="s">${sub}</div></div>
          <input type="password" autocomplete="off" placeholder="API key" value=${services[id]?.apiKey || ''} onChange=${(e) => setService(id, e.currentTarget.value.trim())} /></div>`)}
    </div>
    <div class="group-note">Grok, Claude, OpenAI and OpenRouter search the web on their own. These keys give web search to other providers and bots.</div>

    <div class="group-label">Skills</div>
    <div class="group">
      ${(s.skills || []).map((k) => html`<button class="row" key=${k.id} onClick=${() => setEditingSkill(k)}>
        <${Icon.sparkle} size="20" /><div class="label"><div class="t">${k.name}</div><div class="s">${k.description}</div></div>
        <${Toggle} small on=${k.enabled !== false} onChange=${(v) => app.saveSettings({ skills: s.skills.map((x) => (x.id === k.id ? { ...x, enabled: v } : x)) })} label=${k.name} />
      </button>`)}
      <button class="row" onClick=${() => setEditingSkill({})}><${Icon.plus} size="20" /><div class="label"><div class="t">New skill</div><div class="s">Reusable instructions any bot can load</div></div></button>
    </div>
    ${editingSkill && html`<${SkillEditor} skill=${editingSkill} onCancel=${() => setEditingSkill(null)} onSave=${async (k) => {
      const list = s.skills || [];
      const next = k.id ? list.map((x) => (x.id === k.id ? k : x)) : [...list, { ...k, id: `skill_${Date.now().toString(36)}`, enabled: true }];
      await app.saveSettings({ skills: next });
      setEditingSkill(null);
    }} onDelete=${editingSkill.id ? async () => {
      await app.saveSettings({ skills: (s.skills || []).filter((x) => x.id !== editingSkill.id) });
      setEditingSkill(null);
    } : null} />`}`;
}

function AddServer({ onSave, onCancel }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('');
  return html`<div class="mem">
    <${Field} label="Name"><input class="input" placeholder="e.g. Linear" value=${name} onInput=${(e) => setName(e.currentTarget.value)} /><//>
    <${Field} label="Server URL"><input class="input mono" placeholder="https://mcp.example.com/mcp" value=${url} autocapitalize="off" onInput=${(e) => setUrl(e.currentTarget.value)} /><//>
    <${Field} label="Authorization header (optional)"><input class="input mono" placeholder="Bearer …" value=${auth} autocapitalize="off" onInput=${(e) => setAuth(e.currentTarget.value)} /><//>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn small" onClick=${onCancel}>Cancel</button>
      <button class="btn small primary" disabled=${!name.trim() || !/^https?:\/\//.test(url.trim())} onClick=${() => onSave({ id: `mcp_${Date.now().toString(36)}`, name: name.trim(), url: url.trim(), headers: auth.trim() ? { Authorization: auth.trim() } : {}, enabled: true })}>Add</button>
    </div>
  </div>`;
}

function SkillEditor({ skill, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(skill.name || '');
  const [description, setDescription] = useState(skill.description || '');
  const [instructions, setInstructions] = useState(skill.instructions || '');
  return html`<div class="mem">
    <${Field} label="Name"><input class="input" placeholder="e.g. Weekly SEO report" value=${name} onInput=${(e) => setName(e.currentTarget.value)} /><//>
    <${Field} label="When to use it"><input class="input" placeholder="Short description bots see" value=${description} onInput=${(e) => setDescription(e.currentTarget.value)} /><//>
    <${Field} label="Instructions"><textarea class="textarea" style="min-height:160px" placeholder="Step-by-step instructions, templates, checklists…" value=${instructions} onInput=${(e) => setInstructions(e.currentTarget.value)}></textarea><//>
    <div class="btn-row" style="justify-content:flex-end">
      ${onDelete && html`<button class="btn small danger" onClick=${onDelete}>Delete</button>`}
      <button class="btn small" onClick=${onCancel}>Cancel</button>
      <button class="btn small primary" disabled=${!name.trim() || !instructions.trim()} onClick=${() => onSave({ ...skill, name: name.trim(), description: description.trim(), instructions })}>Save</button>
    </div>
  </div>`;
}

const CONNECTORS = [
  { id: 'gmail', label: 'Gmail', icon: Icon.mail, does: 'Bots read, send and delete your email' },
  { id: 'outlook', label: 'Outlook', icon: Icon.mail, does: 'Bots read, send and delete your email' },
  { id: 'github', label: 'GitHub', icon: Icon.code, does: 'Bots create, edit and delete your repositories' },
];

/** The server's words from a failed call (a ConvexError's data), or `fallback`. */
function serverSays(err, fallback) {
  return typeof err?.data === 'string' ? err.data : fallback;
}

/**
 * Gmail, Outlook and GitHub, connected to the account for its bots
 * (convex/connectors.ts). Connecting leaves for the service's consent screen,
 * which sends the person back to the app (src/main.js finishes it there).
 * GitHub also takes a token the person made.
 */
function ConnectedAccounts() {
  const app = useApp();
  const ui = useUi();
  const signedIn = account.signedIn && signInWorksHere();
  const { data: ready, error: readyError, reload: reloadReady } = useAsync(() => (signedIn ? account.authed('query', 'connectors:available') : Promise.resolve(null)), [signedIn]);
  const { data: list, error: listError, reload } = useAsync(() => (signedIn ? account.authed('query', 'connectors:list') : Promise.resolve([])), [signedIn]);
  const [busy, setBusy] = useState('');
  if (!signedIn) {
    return html`<div class="group-label">Connected accounts</div>
      <div class="group-note" style="margin-top:0">Connect Gmail, Outlook and GitHub for your bots in Holly Bot at ${SITE.replace(/^https:\/\//, '')}, signed in to your account.</div>`;
  }
  const changed = () => {
    reload();
    app.refreshConnections?.();
  };
  const connect = async (c) => {
    setBusy(c.id);
    try {
      const returnTo = `${location.origin}${location.pathname}`;
      location.assign(await account.authed('action', 'connectors:start', { service: c.id, returnTo }));
    } catch (err) {
      setBusy('');
      ui.toast(serverSays(err, `Couldn't start connecting ${c.label}. Check your connection and try again.`), { error: true });
    }
  };
  const useToken = async () => {
    const token = await ui.prompt({
      title: 'Connect GitHub with a token',
      message: 'Make a token on GitHub (Settings → Developer settings → Personal access tokens). A fine-grained token needs Administration, Contents and Metadata set to Read and write for the repositories bots may use; a classic token needs the repo and delete_repo scopes. Paste it here.',
      placeholder: 'github_pat_…',
      confirmText: 'Connect',
      type: 'password',
    });
    if (!token?.trim()) return;
    setBusy('github');
    try {
      const done = await account.authed('action', 'connectors:connectToken', { token: token.trim() });
      ui.toast(`GitHub connected: ${done.account}`);
      changed();
    } catch (err) {
      ui.toast(serverSays(err, "Couldn't connect GitHub. Try again."), { error: true });
    } finally {
      setBusy('');
    }
  };
  const disconnect = async (c, conn) => {
    if (!(await ui.confirm({ title: `Disconnect ${c.label}?`, message: `Your bots stop using ${conn.account}${c.id === 'github' && conn.via === 'token' ? '. To cancel the token itself, delete it on GitHub' : ', and Holly Bot gives up its access'}.`, confirmText: 'Disconnect', danger: true }))) return;
    setBusy(c.id);
    try {
      await account.authed('action', 'connectors:disconnect', { service: c.id });
      changed();
    } catch (err) {
      ui.toast(serverSays(err, `Couldn't disconnect ${c.label}. Try again.`), { error: true });
    } finally {
      setBusy('');
    }
  };
  return html`
    <div class="group-label">Connected accounts</div>
    <${Group}>
      ${CONNECTORS.map((c) => {
        const conn = (list || []).find((x) => x.service === c.id);
        const oauth = !!ready?.[c.id];
        const can = oauth || (c.id === 'github' && !!ready?.githubToken);
        const icon = html`<${c.icon} size="20" />`;
        if (busy === c.id) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${c.does} value="…" />`;
        if (conn) {
          return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${`${conn.account} · ${c.does.replace(/^Bots /, 'bots ')}`} value="Disconnect" onClick=${() => disconnect(c, conn)} />
            ${conn.outdated && oauth && html`<${Row} key=${`${c.id}-again`} title=${`Connect ${c.label} again`} sub="It was connected before bots could delete email. Connecting again lets them." onClick=${() => connect(c)} />`}`;
        }
        if ((!ready && readyError) || (!list && listError)) {
          return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub="Couldn't reach Holly Bot's server" value="Retry" onClick=${() => { reloadReady(); reload(); }} />`;
        }
        if (!ready || !list) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${c.does} value="…" />`;
        if (!can) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub="Not set up on Holly Bot's server yet" />`;
        return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${c.does} value="Connect" onClick=${() => (oauth ? connect(c) : useToken())} />`;
      })}
      ${ready?.github && ready?.githubToken && !(list || []).some((x) => x.service === 'github') && busy !== 'github'
        && html`<${Row} title="Connect GitHub with a token instead" sub="A personal access token you made on GitHub" onClick=${useToken} />`}
    <//>
    <div class="group-note">Bots use them when you ask. With Auto-review on, they ask you before sending or deleting email (showing you exactly which emails) and before making a repository public. Deleting email for good, and deleting a repository, always asks. Holly Bot keeps the access encrypted on its server, only for your bots. Disconnect any time.</div>`;
}

/** What a computer linked to the account is doing (computerState), in words. */
function computerStatus(device) {
  const state = computerState(device);
  if (state === 'running') return 'Running';
  if (state === 'hidden') return "Running without --tunnel, so this app can't reach it";
  if (state === 'old') return 'Needs the latest Holly Computer (below) before this app can use it';
  return device.seenAt ? `Not running · last seen ${formatShort(device.seenAt)}` : 'Not running';
}

/**
 * Computers linked to the account (convex/devices.ts): what each is doing,
 * Connect to control a running one from here, and Unlink. This app connects
 * to a running one by itself when it opens (src/main.js), so Connect is for
 * one that started since, or after Disconnect this device.
 */
function LinkedComputers() {
  const ui = useUi();
  const { data: devices = [], reload } = useAsync(() => account.authed('query', 'devices:list'), []);
  const [busy, setBusy] = useState(null);
  if (!devices.length) return null;
  const connect = async (device) => {
    const conn = computerConnection(device);
    if (!conn || busy) return;
    setBusy(device.id);
    try {
      const remote = new RemoteApp(conn);
      await remote.connect();
      remote.close();
      saveConnection({ ...conn, name: remote.server?.name || device.name });
      location.reload();
    } catch (err) {
      setBusy(null);
      ui.toast(`Couldn't reach ${device.name}. ${err.message}`, { error: true });
    }
  };
  const unlink = async (device) => {
    if (!(await ui.confirm({ title: `Unlink ${device.name}?`, message: `${device.name} stops running your bots and routines. They stay in your account.`, confirmText: 'Unlink', danger: true }))) return;
    try {
      await account.authed('mutation', 'devices:unlink', { id: device.id });
      reload();
    } catch {
      ui.toast("Couldn't unlink it. Check your connection and try again.", { error: true });
    }
  };
  const running = devices.filter((device) => computerConnection(device));
  return html`
    <div class="group-label">Linked to your account</div>
    <${Group}>
      ${devices.map((device) => (device.server
        ? html`<${Row} key=${device.id} title=${device.name} sub=${`${computerStatus(device)} · your plan's own computer, kept linked by Holly Bot`} />`
        : html`<${Row} key=${device.id} title=${device.name}
          sub=${`${computerStatus(device)} · linked ${new Date(device.linkedAt).toLocaleDateString()}`} value="Unlink" onClick=${() => unlink(device)} />`))}
    <//>
    ${running.map((device) => html`<button key=${device.id} class="btn primary block" style="margin-bottom:10px" disabled=${!!busy} onClick=${() => connect(device)}>
      ${busy === device.id ? html`<span class="spinner"></span>` : html`<${Icon.monitor} size="18" /> Connect to ${device.name}`}
    </button>`)}
    <div class="group-note">While Holly Computer runs on a linked computer, Holly Bot on every device signed in to your account connects to it by itself, and your bots run there with its shell, files, browser, screen, mouse and keyboard.</div>`;
}

function ComputerPage() {
  const app = useApp();
  const ui = useUi();
  const [url, setUrl] = useState('http://localhost:8787');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const scriptUrl = new URL('computer/holly-computer.mjs', location.href).href;

  if (app.remote) {
    const info = app.computer.info || {};
    const caps = info.capabilities || {};
    const name = info.hostname || app.server?.name || 'your computer';
    return html`
      <div class="welcome" style="padding-bottom:6px">
        <p><b>Your bots live on ${info.hostname || app.server?.name || 'your computer'}</b> and keep working when your phone is locked. This app is the remote control.</p>
      </div>
      <div style="margin:0 0 12px"><span class=${`status-pill ${app.connection === 'online' ? 'ok' : 'bad'}`}><span class="d"></span>${app.connection === 'online' ? 'Connected' : 'Reconnecting…'}</span></div>
      <${Group}>
        <${Row} title="Computer" value=${info.hostname || '—'} />
        <${Row} title="System" value=${info.os || info.platform || '—'} />
        <${Row} title="Workspace" value=${info.workspace || '—'} />
        <${Row} title="Screen & mouse" value=${caps.desktop ? 'Yes' : caps.screenshot ? 'View only' : 'No'} />
        <${Row} title="Chrome browser" value=${caps.browser ? 'Yes' : 'Not found'} />
      <//>
      ${info.notes?.length > 0 && html`<div class="group-note">${info.notes.join(' ')}</div>`}
      ${app.server?.account?.linked && html`
        <div class="group-label">Your account</div>
        <${Group}><${Row} title="Kept in your account" sub=${`Its bots, chats, memories and keys are kept in your Holly Bot account, and ${name} runs them. Holly Bot on any device signed in to your account connects to it by itself.`} /><//>`}
      <div class="group-note"><b>Keep ${name}'s link private, like a password.</b> Anyone who has it can control ${name} and see your bots, chats and files, and a Wi-Fi link opens it without signing in. If a link gets out, restart Holly Computer with --new-token and the old links stop working.</div>
      <button class="btn block" onClick=${() => ui.openSheet('computer', { tab: 'screen' })}><${Icon.monitor} size="18" /> Open the computer screen</button>
      ${app.server?.account?.linked && html`<button class="btn block danger" style="margin-top:10px" onClick=${async () => {
        if (!(await ui.confirm({ title: `Unlink ${name}?`, message: `Your bots stay in your account, and this device switches to them. ${name} stops running them until you link it again.`, confirmText: 'Unlink', danger: true }))) return;
        try {
          await app.rpc('account.unlink');
        } catch (err) {
          ui.toast(err.message, { error: true });
          return;
        }
        saveConnection(null);
        location.reload();
      }}>Unlink from My Account</button>`}
      <button class="btn block danger" style="margin-top:10px" onClick=${async () => {
        // A computer linked to the account would be found again as the app
        // reopens, so this device is set to run the bots itself instead.
        const linked = app.server?.account?.linked && account.signedIn && signInWorksHere();
        const message = linked
          ? `Your bots stay in your account and ${name} keeps running them. This device will run them itself, without ${name}, until you connect again here.`
          : `Your bots stay on the computer. This app will switch to the bots ${account.signedIn && signInWorksHere() ? 'in your account' : 'that live in this browser'}.`;
        if (!(await ui.confirm({ title: 'Disconnect from your computer?', message, confirmText: 'Disconnect', danger: true }))) return;
        if (linked) runHere();
        else saveConnection(null);
        location.reload();
      }}>Disconnect this device</button>`;
  }

  const connect = async () => {
    setBusy(true);
    try {
      const conn = { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
      const remote = new RemoteApp(conn);
      await remote.connect();
      remote.close();
      // Linked to the account, a computer runs the account's own bots, so
      // there's nothing to copy (it offers the link when this app reconnects).
      if (!app.db?.cloud && app.listAgents().length && !remote.agents.size
        && await ui.confirm({ title: 'Copy your bots to the computer?', message: `Copy the bots, chats and memories ${home(app).from} to your computer so they can keep working there.`, confirmText: 'Copy them', cancelText: 'Start fresh' })) {
        const data = await app.exportData({ includeKeys: true });
        await remote.rpc('data.import', data);
      }
      saveConnection({ ...conn, name: remote.server?.name || '' });
      location.reload();
    } catch (err) {
      ui.toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return html`
    ${app.db?.cloud && html`<${LinkedComputers} />`}
    <div class="welcome" style="padding-bottom:4px">
      ${app.db?.cloud
        ? html`<p><b>Run your bots on your computer.</b> Link Holly Computer on your PC or Mac to your account and it runs your bots around the clock, using the computer like you would: apps, files, a real browser, the screen, mouse and keyboard. Your bots stay in your account, your phone becomes the remote control, and you approve risky actions from it.</p>`
        : html`<p><b>Put your bots on your computer.</b> Run Holly Computer on your PC or Mac and your bots live there around the clock. They use it like you would: apps, files, a real browser, the screen, mouse and keyboard. Your phone becomes the remote control, and you approve risky actions from it.</p>`}
    </div>
    <div class="group" style="padding:14px 18px;font-size:15px;line-height:1.55">
      <p style="margin-top:0">1. Install <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 22 or newer</a> on the computer.</p>
      <p>2. Download <a href=${scriptUrl} download>holly-computer.mjs</a> and run it. Or paste this into a terminal:</p>
      ${[
        ['Mac or Linux (Terminal)', `curl -fsSLO ${scriptUrl} && node holly-computer.mjs --tunnel`],
        ['Windows (PowerShell)', `iwr ${scriptUrl} -OutFile holly-computer.mjs; node holly-computer.mjs --tunnel`],
      ].map(([label, cmd]) => html`
        <div key=${label} style="margin:8px 0 12px">
          <div style="font-size:13px;color:var(--muted);margin-bottom:4px">${label}</div>
          <button class="code-block copyable" title="Copy" onClick=${async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              ui.toast('Copied');
            } catch {
              ui.toast('Couldn’t copy — select the text instead', { error: true });
            }
          }}>${cmd}</button>
        </div>`)}
      <p>3. Scan the QR code it shows with your phone, or open the link it opens on the computer${app.db?.cloud ? ', then tap Add to My Account' : ''}. That's it.${app.db?.cloud ? ' From then on, Holly Bot on any device signed in to your account connects to it by itself while it runs.' : ''}</p>
      <p><b>Keep that link private, like a password.</b> Anyone who has it can control the computer and see your bots, and a Wi-Fi link opens it without signing in. If a link gets out, restart Holly Computer with --new-token and the old links stop working.</p>
      <p style="margin-bottom:0;color:var(--muted);font-size:13.5px"><span class="kbd">--tunnel</span> reaches your computer from anywhere through Cloudflare's free quick tunnel (downloaded automatically the first time); the link changes each time Holly Computer restarts${app.db?.cloud ? ", and once it's linked to your account the app finds the new one by itself" : ''}. On the same Wi-Fi you can use <span class="kbd">--lan</span> instead. Chrome, Edge or Brave on the computer gives bots a real browser. On a Mac, allow your terminal under Privacy & Security → Accessibility and Screen Recording so bots can see and use the screen.</p>
    </div>
    <div class="group-label">Or connect manually</div>
    <${Field} label="Computer URL"><input class="input mono" value=${url} autocapitalize="off" onInput=${(e) => setUrl(e.currentTarget.value)} /><//>
    <${Field} label="Pairing token"><input class="input mono" type="password" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /><//>
    <button class="btn primary block" disabled=${busy || !url.trim() || !token.trim()} onClick=${connect}>${busy ? html`<span class="spinner"></span>` : 'Connect'}</button>`;
}

function AppearancePage() {
  const app = useApp();
  return html`<div class="group">${Object.entries(APPEARANCE).map(([k, label]) => html`
    <button class="row" key=${k} onClick=${() => app.saveSettings({ appearance: k })}>
      <div class="label"><div class="t">${label}</div></div>
      ${(app.settings.appearance || 'system') === k && html`<span class="ok-check"><${Icon.check} /></span>`}
    </button>`)}</div>`;
}

function LanguagePage() {
  const app = useApp();
  return html`<div class="group">${[['system', 'System'], ['en', 'English']].map(([k, label]) => html`
    <button class="row" key=${k} onClick=${() => app.saveSettings({ language: k })}>
      <div class="label"><div class="t">${label}</div></div>
      ${(app.settings.language || 'system') === k && html`<span class="ok-check"><${Icon.check} /></span>`}
    </button>`)}</div>
    <div class="group-note">The app is in English. Your bots reply in whatever language you write to them.</div>`;
}

function HapticsPage() {
  const app = useApp();
  return html`<${Group}><${Row} title="Haptics" sub="Light vibration on taps (Android and some browsers)" toggle=${!!app.settings.haptics} onToggle=${(v) => app.saveSettings({ haptics: v })} /><//>`;
}

function VoicePage() {
  const app = useApp();
  const [list, setList] = useState(voices());
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return undefined;
    const on = () => setList(voices());
    speechSynthesis.addEventListener?.('voiceschanged', on);
    return () => speechSynthesis.removeEventListener?.('voiceschanged', on);
  }, []);
  const cur = app.settings.voice || {};
  return html`
    <${Field} label="Read-aloud voice">
      <select class="select" value=${cur.name || ''} onChange=${(e) => app.saveSettings({ voice: { ...cur, name: e.currentTarget.value } })}>
        <option value="">Default</option>
        ${list.map((v) => html`<option value=${v.name}>${v.name} (${v.lang})</option>`)}
      </select>
    <//>
    <${Field} label=${`Speed ${cur.rate || 1.05}×`}><input type="range" min="0.7" max="1.6" step="0.05" value=${cur.rate || 1.05} onInput=${(e) => app.saveSettings({ voice: { ...cur, rate: +e.currentTarget.value } })} /><//>`;
}

function TimeZonePage({ back }) {
  const app = useApp();
  const [q, setQ] = useState('');
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
  }
  const list = zones.filter((z) => z.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return html`
    <div class="search-bar" style="margin:4px 0 10px"><${Icon.search} /><input placeholder="Search time zones" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} /></div>
    <div class="group">${list.map((z) => html`<button class="row" key=${z} onClick=${async () => {
      await app.saveSettings({ timeZone: z, timeZoneAuto: false });
      back();
    }}><div class="label"><div class="t" style="font-size:16px">${z.replace(/_/g, ' ')}</div></div>${app.timeZone() === z && html`<span class="ok-check"><${Icon.check} /></span>`}</button>`)}</div>`;
}

function MemorySettingsPage() {
  const app = useApp();
  const ui = useUi();
  const s = app.settings;
  const mem = s.memory || {};
  const set = (patch) => app.saveSettings({ memory: { ...mem, ...patch } });
  const ready = app.providers.readyProviders();
  const embedOptions = [['auto', 'Automatic'], ['off', 'Off (local matching)'], ...['openai', 'google', 'mistral'].filter((id) => ready.includes(id)).map((id) => [id, PROVIDERS[id].label])];
  const memModels = [['same', 'Same as each bot'], ...ready.flatMap((id) => modelsFor(app, id).slice(0, 8).map((m) => [`${id}:${m}`, `${PROVIDERS[id].label.split(' ')[0]} · ${m}`]))];
  const first = app.listAgents()[0];
  return html`
    <${Group}>
      <${Row} title="Learn automatically" sub="After each reply, save durable facts to the bot's long-term memory" toggle=${mem.auto !== false} onToggle=${(v) => set({ auto: v })} />
      <div class="row"><div class="label"><div class="t">Memory model</div><div class="s">Extraction, summaries, reflection, group routing</div></div>
        <select value=${s.defaults?.memoryModel || 'same'} onChange=${(e) => app.saveSettings({ defaults: { ...s.defaults, memoryModel: e.currentTarget.value } })}>
          ${memModels.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select></div>
      <div class="row"><div class="label"><div class="t">Semantic search</div><div class="s">Embeddings for smarter recall</div></div>
        <select value=${mem.embeddings || 'auto'} onChange=${(e) => set({ embeddings: e.currentTarget.value })}>
          ${embedOptions.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select></div>
      <div class="row"><div class="label"><div class="t">History kept verbatim</div><div class="s">Auto keeps up to ~400k tokens of raw chat with DeepSeek Flash (1M window); only older turns get summarized</div></div>
        <select value=${String(mem.contextBudget || 'auto')} onChange=${(e) => set({ contextBudget: e.currentTarget.value === 'auto' ? 'auto' : +e.currentTarget.value })}>
          <option value="auto">Auto (half the model's window)</option>
          ${[32000, 64000, 128000, 256000, 400000].map((n) => html`<option value=${n}>${n / 1000}k tokens</option>`)}
        </select></div>
    <//>
    <div class="group-note">Using a small, cheap model for memory work saves money; "Same as each bot" gives the best quality.</div>
    <${Group}>
      <${Row} title="Team memory" sub="Shared notes all bots can read" onClick=${() => (first ? ui.openSheet('memory', { agentId: first.id, tab: 'team' }) : ui.toast('Create a bot first'))} />
      <${Row} title="Re-index memories" sub="Compute embeddings for all bots now" onClick=${async () => {
        let n = 0;
        for (const a of app.listAgents()) n += await app.memory.reindex(a.id).catch(() => 0);
        ui.toast(n ? `Indexed ${n} memories` : 'Nothing to index (needs an OpenAI, Google or Mistral key)');
      }} />
    <//>`;
}

function DataPage() {
  const app = useApp();
  const ui = useUi();
  const [withKeys, setWithKeys] = useState(false);
  const exportNow = async () => {
    const data = await app.exportData({ includeKeys: withKeys });
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `holly-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };
  const importNow = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (!(await ui.confirm({ title: 'Replace everything?', message: `Importing replaces all bots, chats, memories and settings ${home(app).in} with the backup.`, confirmText: 'Import', danger: true }))) return;
      try {
        await app.importData(JSON.parse(await file.text()));
        ui.toast('Backup restored');
        ui.navigate('#/');
      } catch (err) {
        ui.toast(`Import failed: ${err.message}`, { error: true });
      }
    };
    input.click();
  };
  return html`
    <${Group}>
      <${Row} title="Include API keys in export" toggle=${withKeys} onToggle=${setWithKeys} />
      <${Row} title="Export backup" sub="All bots, chats, memories, files, routines and settings" onClick=${exportNow} />
      <${Row} title="Import backup" onClick=${importNow} />
    <//>
    <div class="group-note">${app.db?.cloud
      ? 'Everything is kept in your account, on every device you sign in on. A backup is a copy of your own.'
      : 'Use a backup to move Holly Bot to another device or browser.'} Treat exports that include keys like passwords.</div>
    <${Group}>
      <${Row} title="Pause all routines" onClick=${async () => ui.toast(`Paused ${await app.routines.setAllEnabled(false)} routines`)} />
      <${Row} title="Erase all data" danger onClick=${async () => {
        if (await ui.confirm({ title: 'Erase everything?', message: `Deletes all bots, chats, memories, files, routines and keys ${home(app).from}. Your account stays.`, confirmText: 'Erase', danger: true })) {
          await app.resetAll();
          ui.navigate('#/');
          ui.toast('All data erased');
        }
      }} />
    <//>`;
}

function HelpPage() {
  return html`<div class="bubble plain-bot" style="max-width:100%;line-height:1.5">
    <h3>Getting started</h3>
    <p>1. <b>Add a key</b> in Settings → API Keys (xAI for Grok, or Anthropic, OpenAI, Google, OpenRouter…).<br />2. Tap <b>+ → New Bot</b>, name it and pick a look.<br />3. Chat. Your bot learns about you and remembers across conversations.</p>
    <h3>Multiple bots</h3>
    <p>Every bot has its own name, personality, model, memory, files and routines. Bots can <b>message each other</b> (“Ask Nova to review this”), <b>delegate</b> longer tasks, and share a <b>team memory</b>. Start a <b>group chat</b> with + → New Group Chat and @mention bots.</p>
    <h3>Memory</h3>
    <p>Tap a bot's name → Memories to see, edit, pin or delete what it knows. Core memory is always in view; long-term memories are recalled when relevant; older chat is summarized automatically.</p>
    <h3>Tools</h3>
    <p>Web search, a Python/JavaScript sandbox, files, image generation, routines and plugins (MCP). Connect a <b>Bot Computer</b> for shell, real files, a browser and local plugins. With Auto-review on, risky actions ask for permission first.</p>
    <h3>Email and GitHub</h3>
    <p>Connect <b>Gmail</b>, <b>Outlook</b> or <b>GitHub</b> in Settings → Plugins, then just ask: “Anything from Anna this week?”, “Reply that Friday works”, “Delete last month's newsletters”, “Make a private repo called notes and add a README”. With Auto-review on, you see each email before it goes out and each one before it's deleted. Deleted email goes to the trash, where you can get it back; deleting for good, and deleting a repository, always ask.</p>
    <h3>Your subscription</h3>
    <p>Settings → <b>Subscription</b> shows your plan. Tap it to change plan, update your card, see invoices or cancel, on Stripe. A cancelled plan runs to the end of the period you've paid for, and your bots, chats and memories stay in your account.</p>
    <p>Every plan comes with <b>your own computer</b>, a server that runs your bots around the clock. The app connects to it by itself, and Settings shows how it's doing. Upgrading makes it bigger; downgrading moves your bots' files to a smaller one.</p>
    <h3>Install as an app</h3>
    <p>iPhone: Share → Add to Home Screen. Android/desktop Chrome: Install app.</p>
    <p><a href="https://github.com/xgamer791/holly-bot#readme" target="_blank" rel="noopener">Full guide on GitHub ↗</a></p>
  </div>`;
}

/** privacy.html or terms.html (the same pages the sign-in screens link to),
 * shown inside Settings. */
function LegalPage({ file, title }) {
  const [body, setBody] = useState(null);
  useEffect(() => {
    fetch(file)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => setBody(new DOMParser().parseFromString(text, 'text/html').querySelector('main')?.innerHTML || ''))
      .catch(() => setBody(''));
  }, [file]);
  if (body === null) return html`<div style="display:flex;justify-content:center;padding:40px"><span class="spinner"></span></div>`;
  return html`
    ${body
      ? html`<div class="bubble plain-bot legal-body" style="max-width:100%;line-height:1.5" dangerouslySetInnerHTML=${{ __html: body }}></div>`
      : html`<p class="hint">The ${title} couldn't be loaded here.</p>`}
    <p style="text-align:center"><a href=${file} target="_blank" rel="noopener">Open in the browser ↗</a></p>`;
}

function PrivacyPage() {
  return html`<${LegalPage} file="privacy.html" title="Privacy Policy" />`;
}

function TermsPage() {
  return html`<${LegalPage} file="terms.html" title="Terms of Service" />`;
}
