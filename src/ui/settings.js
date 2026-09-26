import { html, useState, useEffect } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useAsync } from './hooks.js';
import { Sheet, Group, Row, Field, Toggle, downloadBlob, useDrawer } from './components.js';
import { Icon } from './icons.js';
import { Avatar } from './avatar.js';
import { initials } from '../core/util.js';
import { APP_NAME, APP_VERSION } from '../core/constants.js';
import { resolveLanguage } from '../core/i18n.js';
import {
  RemoteApp, chooseComputer, computerConnection, computerState, declineComputer, isPaired, probeComputer, reachComputer, runHere, sameComputer, saveConnection,
} from '../remote/remote-app.js';
import { account, signInWorksHere, SITE } from '../account/account.js';
import {
  LANGUAGES, dateText, language, listText, mark, number, setLanguage, shortTime, tr, trn, trx,
} from './i18n.js';

const APPEARANCE = { system: mark('System · Black'), black: mark('Black'), dark: mark('Dark'), light: mark('Light') };
const SIGN_IN_WITH = { apple: 'Apple', google: 'Google' };
/** Holly Computer for Windows' installer, from its latest GitHub release (.github/workflows/windows.yml). */
const WINDOWS_SETUP = 'https://github.com/xgamer791/holly-bot/releases/latest/download/Holly-Computer-Setup.exe';

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

/** Where this app keeps bots, chats and keys: 'computer', 'account' or
 * 'browser', for the wording around Settings. */
function home(app) {
  if (app.remote) return 'computer';
  if (app.db?.cloud) return 'account';
  return 'browser';
}

/** The first letter small, for text that goes mid-sentence. */
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The top of Settings: who is signed in (their initials, name, email and
 * how they sign in), and under it the usage meter, how much of the month's
 * AI credits is left, which opens the Usage page. Where there are no
 * accounts (Holly Computer's Wi-Fi links, browser automation) only the meter
 * shows. */
function AccountHeader({ acct, go }) {
  const { credits } = useCredits();
  const pct = credits ? creditsShare(credits) : null;
  const user = acct.user || {};
  const via = listText((user.providers || []).map((p) => SIGN_IN_WITH[p] || p));
  return html`
    ${acct.signedIn && html`<div class="drawer-account">
      <span class="initials">${initials(user.name || user.email)}</span>
      <div class="who">
        <div class="name">${user.name || user.email || tr('Holly Bot account')}</div>
        ${user.name && user.email && html`<div class="detail">${user.email}</div>`}
        <div class="detail">${via ? tr('Signed in with {via}', { via }) : tr('Signed in')}</div>
      </div>
    </div>`}
    <button class="drawer-usage" onClick=${() => go('usage')}>
      <span class="usage-head">
        <span class="t">${tr('Usage')}</span>
        <span class="usage-left">${pct == null ? '—' : tr('{pct}% left', { pct })}</span>
        <${Icon.chevron} class="chev" />
      </span>
      ${pct != null && html`<span class="credits-bar" role="meter" aria-label=${tr('AI credits left this month')} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
        <span class=${pct <= 10 ? 'low' : pct <= 25 ? 'mid' : ''} style=${`width:${pct}%`}></span>
      </span>`}
    </button>`;
}

/** Settings is a drawer from the left that pushes the app over, with a
 * handle to drag it closed (useDrawer in src/ui/components.js). */
export function SettingsSheet({ onClose: remove, page: initialPage, provider: initialProvider }) {
  const app = useApp();
  const drawer = useDrawer(remove);
  const onClose = drawer.close;
  useTopics(['settings', 'computer', 'plugins', 'agents']);
  const [stack, setStack] = useState(() => (initialPage ? [{ page: initialPage, provider: initialProvider }] : []));
  const top = stack[stack.length - 1];
  const go = (page, extra = {}) => setStack([...stack, { page, ...extra }]);
  const back = () => setStack(stack.slice(0, -1));
  const titles = {
    usage: mark('Usage'), keys: mark('Usage'), plugins: mark('Plugins'),
    computer: mark('Bot Computer'), appearance: mark('Appearance'), language: mark('Language'), data: mark('Data & Backup'),
    help: mark('Help Center'), privacy: mark('Privacy Policy'), terms: mark('Terms of Service'),
  };
  const left = top
    ? html`<button class="circle-btn" aria-label=${tr('Back')} onClick=${back}><${Icon.back} /></button>`
    : html`<button class="circle-btn" aria-label=${tr('Close')} onClick=${onClose}><${Icon.x} /></button>`;
  const pages = {
    usage: UsagePage, keys: UsagePage, plugins: PluginsPage, computer: ComputerPage,
    appearance: AppearancePage, language: LanguagePage, data: DataPage,
    help: HelpPage, privacy: PrivacyPage, terms: TermsPage,
  };
  const Page = (top && pages[top.page]) || MainPage;
  return html`<${Sheet} drawer=${drawer} title=${top ? tr(titles[top.page]) : tr('Settings')} left=${left} onClose=${onClose}>
    <${Page} go=${go} back=${back} onClose=${onClose} ...${top || {}} />
  <//>`;
}

/** Settings itself: who is signed in and the usage meter, then the settings
 * in sections (the bots, safety and data, preferences, support), Sign Out,
 * and the app's version. */
function MainPage({ go, onClose }) {
  const app = useApp();
  const ui = useUi();
  const acct = useAccount();
  const s = app.settings;
  const set = (patch) => app.saveSettings(patch);
  const lang = s.language || 'system';
  return html`
    <${AccountHeader} acct=${acct} go=${go} />
    <${Group} label=${tr('Bots')}>
      <${Row} title=${tr('Plugins')} sub=${tr('Gmail, Outlook, GitHub, Higgsfield, tools and skills')} onClick=${() => go('plugins')} />
      <${Row} title=${tr('Routines')} onClick=${() => ui.openSheet('routines', {})} />
    <//>
    <${Group} label=${tr('Safety & data')}>
      <${Row} title=${tr('Auto-review')} sub=${tr('Require approval for risky shell, MCP, and computer actions, sending or deleting email, and publishing repositories.')} toggle=${s.askFirst === true} onToggle=${(v) => set({ askFirst: v })} />
      <${Row} title=${tr('Data & Backup')} onClick=${() => go('data')} />
    <//>
    <${Group} label=${tr('Preferences')}>
      <${Row} title=${tr('Notifications')} toggle=${!!s.notifications} onToggle=${async (v) => {
        if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
          const p = await Notification.requestPermission().catch(() => 'denied');
          if (p !== 'granted') {
            ui.toast(tr('Notifications are blocked for this site. On iPhone, add Holly Bot to your Home Screen first.'), { error: true });
            return;
          }
        }
        set({ notifications: v });
      }} />
      <${Row} title=${tr('Appearance')} value=${tr(APPEARANCE[s.appearance] || APPEARANCE.system)} onClick=${() => go('appearance')} />
      <${Row} title=${tr('Language')} value=${lang === 'system' ? tr('System') : LANGUAGES.find((l) => l.code === lang)?.name || tr('System')} onClick=${() => go('language')} />
    <//>
    <${Group} label=${tr('Support')}>
      <${Row} title=${tr('Help Center')} onClick=${() => go('help')} />
      <${Row} title=${tr('Send Feedback')} chevron=${false} onClick=${() => window.open('https://github.com/xgamer791/holly-bot/issues/new', '_blank', 'noopener')}>
        <${Icon.external} class="chev" />
      <//>
      <${Row} title=${tr('Privacy Policy')} onClick=${() => go('privacy')} />
      <${Row} title=${tr('Terms of Service')} onClick=${() => go('terms')} />
    <//>
    <div class="drawer-signout">
      ${acct.signedIn ? html`
        <${Row} title=${tr('Sign Out')} sub=${app.remote ? tr('Your bots stay on your computer.') : tr('Your bots, chats, memories and keys stay in your account.')} chevron=${false} danger onClick=${() => signOut(app, ui)} />`
      : html`<${Row} title=${tr('Sign Out')} sub=${tr('Removes your API keys from this device. Bots and memories stay.')} chevron=${false} danger onClick=${async () => {
        if (!(await ui.confirm({ title: tr('Sign out?'), message: tr('Your API keys will be removed. Your bots, chats and memories are kept.'), confirmText: tr('Sign Out'), danger: true }))) return;
        const providers = {};
        for (const [id, p] of Object.entries(s.providers || {})) providers[id] = { ...p, apiKey: '' };
        const services = {};
        for (const [id, p] of Object.entries(s.services || {})) services[id] = { ...p, apiKey: '' };
        await set({ providers, services, computer: { url: s.computer?.url || '', token: '' } });
        app.computer.connected = false;
        ui.toast(tr('Signed out — keys removed'));
        onClose();
      }} />`}
    </div>
    <div class="drawer-foot">
      <${Avatar} shape="cloud" color="blue" size=${26} expression="upRight" />
      <span class="n">${APP_NAME}</span>
      <span class="v">${APP_VERSION}</span>
    </div>`;
}

/** Signs out of the account, leaving nothing of it on this device: unsent
 * changes go up first (for a few seconds), and the link to a Holly Computer is
 * forgotten here (signing in again finds one linked to the account; one that
 * isn't needs its link opened again). */
async function signOut(app, ui) {
  const name = app.server?.name || tr('your computer');
  const message = app.remote && app.server?.account?.linked
    ? tr("You'll be back at the welcome screen. Your bots stay in your account and {name} keeps running them. Sign in again and this device connects to it by itself.", { name })
    : app.remote
      ? tr("You'll be back at the welcome screen, and this device forgets your Holly Computer until you open its link again. Your bots stay on the computer.")
      : tr("You'll be back at the welcome screen. Your bots, chats, memories and API keys stay in your account for when you sign in again.");
  if (!(await ui.confirm({ title: tr('Sign out?'), message, confirmText: tr('Sign Out'), danger: true }))) return;
  ui.toast(tr('Signing out…'));
  if (!app.remote) {
    app.stopScheduler();
    app.runtime.stopAll();
  }
  await app.db?.close?.({ forget: true });
  saveConnection(null);
  await account.signOut(); // src/main.js reloads into the welcome screen
}

/** This month's AI credits (convex/credits.ts `mine`), for the Usage row and
 * page: null while unknown, or without a plan that gives any. */
function useCredits() {
  const here = account.signedIn && signInWorksHere();
  const { data, loading, reload } = useAsync(() => (here ? account.authed('query', 'credits:mine').catch(() => null) : Promise.resolve(null)), [here]);
  return { credits: data ?? null, loading, reload };
}

/** What's left of the month's credits, as a whole percent (1% while any are left). */
function creditsShare(c) {
  if (!c?.allowance || c.balance <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((c.balance / c.allowance) * 100)));
}

/** Millionths of a dollar as credits (1 credit per cent), for showing. */
const asCredits = (micros) => number(Math.floor(Math.max(0, micros) / 10_000));

/**
 * Settings → Usage: this month's AI credits as a bar that drops as bots use
 * them and fills up again when they refill, with no money shown. Read again
 * every few seconds while it's open, so it follows the bots as they work.
 */
function UsagePage() {
  const { credits, loading, reload } = useCredits();
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), 5000);
    return () => clearInterval(t);
  }, []);
  if (!account.signedIn || !signInWorksHere()) {
    return html`<p class="hint" style="font-size:14.5px;margin:4px">${tr('Your AI credits come with your Holly Bot plan. Sign in to Holly Bot at {site} to see them.', { site: SITE.replace(/^https:\/\//, '') })}</p>`;
  }
  if (!credits) {
    return html`<p class="hint" style="font-size:14.5px;margin:4px">${loading ? tr('Loading…') : tr('Your AI credits come with your Holly Bot plan.')}</p>`;
  }
  const pct = creditsShare(credits);
  const refill = dateText(credits.refillsAt, { month: 'long', day: 'numeric' });
  return html`
    <div class="credits-card" role="meter" aria-label=${tr('AI credits left this month')} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
      <div class="credits-head"><b>${tr('AI credits')}</b><span>${tr('{pct}% left', { pct })}</span></div>
      <div class="credits-bar"><span class=${pct <= 10 ? 'low' : pct <= 25 ? 'mid' : ''} style=${`width:${pct}%`}></span></div>
      <div class="credits-sub">${tr('{left} of {total} left · Refills {date}', { left: asCredits(credits.balance), total: asCredits(credits.allowance), date: refill })}</div>
    </div>
    ${!credits.ready && html`<p class="hint" style="font-size:14px;margin:4px 4px 10px">${tr("Holly Bot's AI isn't switched on yet, so your bots aren't using these credits.")}</p>`}
    <p class="hint" style="font-size:14px;margin:4px">${tr("Your plan's credits refill every month; what's left doesn't carry over. Everything your bots think through uses some: long chats, files and DeepSeek V4 Pro use more. When they run out, your bots pause until they refill.")}</p>
    <p class="hint" style="font-size:14px;margin:10px 4px 4px">${tr("Credits go twice as far outside DeepSeek's busy hours (01:00–04:00 and 06:00–10:00 UTC on weekdays).")}</p>`;
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
  // Servers on the Bot Computer (its ~/.holly/mcp.json): switched on and off
  // and removed from here once it's new enough (capabilities.mcpConfig).
  const local = state.filter((p) => p.via === 'computer');
  const canChangeLocal = !!(app.computer.connected && app.computer.info?.capabilities?.mcpConfig);
  const changeLocal = async (change) => {
    try {
      await app.computer.mcpChange(change);
      await app.plugins.refresh();
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };
  const removeLocal = async (name) => {
    if (!(await ui.confirm({ title: tr('Remove {name}?', { name }), message: tr('It stops running on your Bot Computer and your bots lose its tools. Its settings, and any keys in them, are deleted there.'), confirmText: tr('Remove'), danger: true }))) return;
    changeLocal({ op: 'remove', name });
  };
  // One still starting (npx fetching it the first time) is looked at again
  // every few seconds. With the bots on the computer, it says so itself.
  const starting = !app.remote && local.some((p) => p.status === 'starting');
  useEffect(() => {
    if (!starting) return undefined;
    const t = setInterval(() => app.plugins.refresh().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [starting]);
  const services = s.services || {};
  const setService = (id, apiKey) => app.saveSettings({ services: { ...services, [id]: { ...(services[id] || {}), apiKey } } });
  return html`
    <${ConnectedAccounts} />

    <div class="group-label">${tr('MCP servers')}</div>
    <div class="group">
      ${servers.map((srv) => {
        const st = state.find((x) => x.key === `direct:${srv.id}`);
        return html`<div class="row" key=${srv.id}>
          <${Icon.plug} size="20" />
          <div class="label"><div class="t">${srv.name}</div><div class="s">${st?.status === 'ok' ? trn(st.tools.length, '{n} tool', '{n} tools') : st?.status === 'error' ? tr('Error: {error}', { error: st.error }) : srv.enabled === false ? tr('Off') : tr('Connecting…')}</div></div>
          <${Toggle} small on=${srv.enabled !== false} onChange=${(v) => saveServers(servers.map((x) => (x.id === srv.id ? { ...x, enabled: v } : x)))} label=${srv.name} />
          <button class="icon-btn" aria-label=${tr('Remove')} onClick=${() => saveServers(servers.filter((x) => x.id !== srv.id))}><${Icon.trash} /></button>
        </div>`;
      })}
      ${local.map((p) => html`<div class="row" key=${p.key}><${Icon.monitor} size="20" />
        <div class="label"><div class="t">${p.name}</div><div class="s">${p.status === 'ok' ? trn(p.tools.length, '{n} tool · on Bot Computer', '{n} tools · on Bot Computer')
          : p.status === 'starting' ? tr('Starting on your Bot Computer…') : p.status === 'off' ? tr('Off') : p.error ? tr('Error: {error}', { error: p.error }) : p.status}</div></div>
        ${canChangeLocal && p.key !== 'computer:*' && html`
          <${Toggle} small on=${p.status !== 'off'} onChange=${(v) => changeLocal({ op: 'enable', name: p.name, enabled: v })} label=${p.name} />
          <button class="icon-btn" aria-label=${tr('Remove')} onClick=${() => removeLocal(p.name)}><${Icon.trash} /></button>`}
      </div>`)}
      <button class="row" onClick=${() => setAdding(!adding)}><${Icon.plus} size="20" /><div class="label"><div class="t">${tr('Add MCP server')}</div></div></button>
    </div>
    <div class="group-note">${trx('Add a server by pasting its settings: the JSON its instructions give for Claude Desktop or Cursor. One with a command runs on your Bot Computer, kept in {file}; one with a url (Streamable HTTP) is called over the web, and from a browser it must allow CORS.', { file: html`<span class="kbd">~/.holly/mcp.json</span>` })}</div>
    ${adding && html`<${AddServers} servers=${servers} saveServers=${saveServers} onCancel=${() => setAdding(false)} onAdded=${(names) => {
      setAdding(false);
      ui.toast(tr('Added {name}', { name: listText(names) }));
    }} />`}

    <div class="group-label">${tr('Search & reading')}</div>
    <div class="group">
      ${[['tavily', 'Tavily', tr('Web search API')], ['exa', 'Exa', tr('Neural web search')], ['jina', 'Jina', tr('Reader & search (optional key)')], ['brave', 'Brave Search', tr('Used through your Bot Computer')]].map(([id, label, sub]) => html`
        <div class="row" key=${id}><div class="label"><div class="t">${label}</div><div class="s">${sub}</div></div>
          <input type="password" autocomplete="off" placeholder=${tr('API key')} value=${services[id]?.apiKey || ''} onChange=${(e) => setService(id, e.currentTarget.value.trim())} /></div>`)}
    </div>
    <div class="group-note">${tr('Grok, Claude, OpenAI and OpenRouter search the web on their own. These keys give web search to other providers and bots.')}</div>

    <div class="group-label">${tr('Skills')}</div>
    <div class="group">
      ${(s.skills || []).map((k) => html`<button class="row" key=${k.id} onClick=${() => setEditingSkill(k)}>
        <${Icon.sparkle} size="20" /><div class="label"><div class="t">${k.name}</div><div class="s">${k.description}</div></div>
        <${Toggle} small on=${k.enabled !== false} onChange=${(v) => app.saveSettings({ skills: s.skills.map((x) => (x.id === k.id ? { ...x, enabled: v } : x)) })} label=${k.name} />
      </button>`)}
      <button class="row" onClick=${() => setEditingSkill({})}><${Icon.plus} size="20" /><div class="label"><div class="t">${tr('New skill')}</div><div class="s">${tr('Reusable instructions any bot can load')}</div></div></button>
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

/** What the settings box shows before anything is pasted. */
const MCP_EXAMPLE = `{ "mcpServers": {
  "name": {
    "command": "npx",
    "args": ["-y", "package-name"],
    "env": { "API_KEY": "…" }
  }
} }`;

/** A name for a server from its package ("@scope/dataforseo-mcp-server@latest" → "dataforseo") or website ("mcp.linear.app" → "linear"). */
function serverName(spec) {
  if (spec.url) {
    try {
      return new URL(spec.url).hostname.replace(/^(www|mcp|api)\./, '').split('.')[0] || 'server';
    } catch {
      return 'server';
    }
  }
  const pkg = (spec.args || []).find((a) => !String(a).startsWith('-')) || spec.command || 'server';
  return String(pkg).replace(/^@[^/]+\//, '').replace(/@[^@/]*$/, '').replace(/\.(m?js|py)$/, '').split(/[\\/]/).pop()
    .replace(/(^mcp[-_]server[-_]|^server[-_]|[-_]mcp[-_]server$|[-_]mcp$|^mcp[-_])/gi, '') || 'server';
}

/**
 * Pasted MCP settings → the servers in them: `local` ({ name: { command,
 * args, env, cwd } }) to run on the Bot Computer, and `remote` ([{ name, url,
 * headers }]) for the app to call. Takes the "mcpServers" JSON that Claude
 * Desktop, Cursor and most servers' instructions give (VS Code's "servers"
 * too), servers by name, one server's settings on their own, or just a
 * server's web address. Forgiving of what a phone's keyboard does to quotes,
 * and of trailing commas. Throws a message to show when it can't be used.
 */
export function readMcpSettings(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error(tr('Paste a server’s settings first.'));
  if (/^https?:\/\/\S+$/i.test(raw)) return { local: {}, remote: [{ name: serverName({ url: raw }), url: raw, headers: {} }] };
  // As pasted first, so no value is changed; then with a phone keyboard's
  // curly quotes made straight, trailing commas dropped, and braces put
  // around "name": { … } pasted without them.
  const straight = raw.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
  const noCommas = (t) => t.replace(/,(\s*[}\]])/g, '$1');
  let data;
  for (const t of [raw, straight].flatMap((x) => [x, noCommas(x), `{${x}}`, noCommas(`{${x}}`)])) {
    try {
      data = JSON.parse(t);
      break;
    } catch { /* the next way */ }
  }
  if (data === undefined) throw new Error(tr("That isn't valid JSON. Check its quotes, commas and braces."));
  let found = data?.mcpServers || data?.servers || data?.mcp?.servers || data;
  if (found && (found.command || found.url || found.serverUrl)) found = { [serverName(found)]: found };
  if (!found || typeof found !== 'object' || Array.isArray(found) || !Object.keys(found).length) {
    throw new Error(tr('No servers in that. It should look like { "mcpServers": { "name": { … } } }.'));
  }
  const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, String(v ?? '')]));
  const local = {};
  const remote = [];
  const values = [];
  for (const [name, spec] of Object.entries(found)) {
    if (!spec || typeof spec !== 'object') throw new Error(tr('“{name}” has no settings.', { name }));
    const url = spec.url || spec.serverUrl;
    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new Error(tr('“{name}” needs a web address starting with https://.', { name }));
      const headers = strings(spec.headers);
      remote.push({ name, url, headers });
      values.push(...Object.values(headers));
    } else if (typeof spec.command === 'string' && spec.command.trim()) {
      const env = strings(spec.env);
      const args = (Array.isArray(spec.args) ? spec.args : []).map(String);
      local[name] = { command: spec.command.trim(), args, ...(Object.keys(env).length ? { env } : {}), ...(spec.cwd ? { cwd: String(spec.cwd) } : {}) };
      values.push(...Object.values(env), ...args);
    } else throw new Error(tr('“{name}” needs a command to run (such as npx) or a url.', { name }));
  }
  // Left as the instructions wrote it: <API password>, YOUR_API_KEY, your-token-here…
  const blank = values.find((v) => /^<[^<>]+>$/.test(v.trim()) || /^your[-_ ]?([a-z]+[-_ ])*(key|token|password|secret|login)([-_ ]here)?$/i.test(v.trim()));
  if (blank) throw new Error(tr('Put your own value in place of {placeholder} first.', { placeholder: blank }));
  return { local, remote };
}

/** Settings → Plugins → Add MCP server: paste a server's settings. One with
 * a command goes to the Bot Computer (/v1/mcp/servers), one with a url to
 * the app's own list; either replaces one with the same name. */
function AddServers({ servers, saveServers, onAdded, onCancel }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    let found;
    try {
      found = readMcpSettings(text);
    } catch (err) {
      setError(err.message);
      return;
    }
    const localNames = Object.keys(found.local);
    if (localNames.length && !app.computer.connected) {
      setError(tr('A server with a command runs on your Bot Computer. Connect one first, with the computer button at the top right.'));
      return;
    }
    if (localNames.length && !app.computer.info?.capabilities?.mcpConfig) {
      setError(tr('Your Bot Computer needs the latest Holly Computer for this. A Holly Bot server updates itself within a few minutes; on your own computer, restart Holly Computer.'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      if (found.remote.length) {
        const names = new Set(found.remote.map((r) => r.name));
        const stamp = Date.now().toString(36);
        await saveServers([...servers.filter((x) => !names.has(x.name)), ...found.remote.map((r, i) => ({ id: `mcp_${stamp}${i}`, ...r, enabled: true }))]);
      }
      if (localNames.length) {
        await app.computer.mcpChange({ op: 'add', servers: found.local });
        await app.plugins.refresh().catch(() => {});
      }
      onAdded([...localNames, ...found.remote.map((r) => r.name)]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="mem">
    <${Field} label=${tr('Server settings (JSON)')}>
      <textarea class="textarea mono" style="min-height:190px" placeholder=${MCP_EXAMPLE} value=${text} spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
        onInput=${(e) => { setText(e.currentTarget.value); setError(''); }}></textarea>
    <//>
    ${error && html`<p class="auth-error" role="alert">${error}</p>`}
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn small" onClick=${onCancel}>${tr('Cancel')}</button>
      <button class="btn small primary" disabled=${busy || !text.trim()} onClick=${add}>${busy ? html`<span class="spinner"></span>` : tr('Add')}</button>
    </div>
  </div>`;
}

function SkillEditor({ skill, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(skill.name || '');
  const [description, setDescription] = useState(skill.description || '');
  const [instructions, setInstructions] = useState(skill.instructions || '');
  return html`<div class="mem">
    <${Field} label=${tr('Name')}><input class="input" placeholder=${tr('e.g. Weekly SEO report')} value=${name} onInput=${(e) => setName(e.currentTarget.value)} /><//>
    <${Field} label=${tr('When to use it')}><input class="input" placeholder=${tr('Short description bots see')} value=${description} onInput=${(e) => setDescription(e.currentTarget.value)} /><//>
    <${Field} label=${tr('Instructions')}><textarea class="textarea" style="min-height:160px" placeholder=${tr('Step-by-step instructions, templates, checklists…')} value=${instructions} onInput=${(e) => setInstructions(e.currentTarget.value)}></textarea><//>
    <div class="btn-row" style="justify-content:flex-end">
      ${onDelete && html`<button class="btn small danger" onClick=${onDelete}>${tr('Delete')}</button>`}
      <button class="btn small" onClick=${onCancel}>${tr('Cancel')}</button>
      <button class="btn small primary" disabled=${!name.trim() || !instructions.trim()} onClick=${() => onSave({ ...skill, name: name.trim(), description: description.trim(), instructions })}>${tr('Save')}</button>
    </div>
  </div>`;
}

const CONNECTORS = [
  { id: 'gmail', label: 'Gmail', icon: Icon.mail, does: mark('Bots read, send and delete your email') },
  { id: 'outlook', label: 'Outlook', icon: Icon.mail, does: mark('Bots read, send and delete your email') },
  { id: 'github', label: 'GitHub', icon: Icon.code, does: mark('Bots create, edit and delete your repositories') },
  { id: 'higgsfield', label: 'Higgsfield', icon: Icon.image, does: mark('Bots make images and videos with your Higgsfield credits') },
];

/** The server's words from a failed call (a ConvexError's data, in the app's
 * language when the dictionary has them), or `fallback`. */
function serverSays(err, fallback) {
  return typeof err?.data === 'string' ? tr(err.data) : fallback;
}

/**
 * Gmail, Outlook, GitHub and Higgsfield, connected to the account for its
 * bots (convex/connectors.ts). Connecting leaves for the service's consent
 * screen (Higgsfield's sign-in), which sends the person back to the app
 * (src/main.js finishes it there). GitHub also takes a token the person made.
 */
function ConnectedAccounts() {
  const app = useApp();
  const ui = useUi();
  const signedIn = account.signedIn && signInWorksHere();
  const { data: ready, error: readyError, reload: reloadReady } = useAsync(() => (signedIn ? account.authed('query', 'connectors:available') : Promise.resolve(null)), [signedIn]);
  const { data: list, error: listError, reload } = useAsync(() => (signedIn ? account.authed('query', 'connectors:list') : Promise.resolve([])), [signedIn]);
  const [busy, setBusy] = useState('');
  if (!signedIn) {
    return html`<div class="group-label">${tr('Connected accounts')}</div>
      <div class="group-note" style="margin-top:0">${tr('Connect Gmail, Outlook, GitHub and Higgsfield for your bots in Holly Bot at {site}, signed in to your account.', { site: SITE.replace(/^https:\/\//, '') })}</div>`;
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
      ui.toast(serverSays(err, tr("Couldn't start connecting {service}. Check your connection and try again.", { service: c.label })), { error: true });
    }
  };
  const useToken = async () => {
    const token = await ui.prompt({
      title: tr('Connect GitHub with a token'),
      message: tr('Make a token on GitHub (Settings → Developer settings → Personal access tokens). A fine-grained token needs Administration, Contents and Metadata set to Read and write for the repositories bots may use; a classic token needs the repo and delete_repo scopes. Paste it here.'),
      placeholder: 'github_pat_…',
      confirmText: tr('Connect'),
      type: 'password',
    });
    if (!token?.trim()) return;
    setBusy('github');
    try {
      const done = await account.authed('action', 'connectors:connectToken', { token: token.trim() });
      ui.toast(tr('GitHub connected: {account}', { account: done.account }));
      changed();
    } catch (err) {
      ui.toast(serverSays(err, tr("Couldn't connect GitHub. Try again.")), { error: true });
    } finally {
      setBusy('');
    }
  };
  const disconnect = async (c, conn) => {
    const message = c.id === 'github' && conn.via === 'token'
      ? tr('Your bots stop using {account}. To cancel the token itself, delete it on GitHub.', { account: conn.account })
      : tr('Your bots stop using {account}, and Holly Bot gives up its access.', { account: conn.account });
    if (!(await ui.confirm({ title: tr('Disconnect {service}?', { service: c.label }), message, confirmText: tr('Disconnect'), danger: true }))) return;
    setBusy(c.id);
    try {
      await account.authed('action', 'connectors:disconnect', { service: c.id });
      changed();
    } catch (err) {
      ui.toast(serverSays(err, tr("Couldn't disconnect {service}. Try again.", { service: c.label })), { error: true });
    } finally {
      setBusy('');
    }
  };
  return html`
    <div class="group-label">${tr('Connected accounts')}</div>
    <${Group}>
      ${CONNECTORS.map((c) => {
        const conn = (list || []).find((x) => x.service === c.id);
        const oauth = !!ready?.[c.id];
        const can = oauth || (c.id === 'github' && !!ready?.githubToken);
        const icon = html`<${c.icon} size="20" />`;
        if (busy === c.id) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${tr(c.does)} value="…" />`;
        if (conn) {
          // Higgsfield's tools come from its own server (src/core/plugins.js): when they can't be had, it says why.
          const trouble = app.plugins.list().find((p) => p.key === `connector:${c.id}` && p.status === 'error');
          const sub = trouble ? tr('Error: {error}', { error: trouble.error }) : tr('{account} · {does}', { account: conn.account, does: lowerFirst(tr(c.does)) });
          return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${sub} value=${tr('Disconnect')} onClick=${() => disconnect(c, conn)} />
            ${conn.outdated && oauth && html`<${Row} key=${`${c.id}-again`} title=${tr('Connect {service} again', { service: c.label })} sub=${tr('It was connected before bots could delete email. Connecting again lets them.')} onClick=${() => connect(c)} />`}`;
        }
        if ((!ready && readyError) || (!list && listError)) {
          return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${tr("Couldn't reach Holly Bot's server")} value=${tr('Retry')} onClick=${() => { reloadReady(); reload(); }} />`;
        }
        if (!ready || !list) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${tr(c.does)} value="…" />`;
        if (!can) return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${tr("Not set up on Holly Bot's server yet")} />`;
        return html`<${Row} key=${c.id} icon=${icon} title=${c.label} sub=${tr(c.does)} value=${tr('Connect')} onClick=${() => (oauth ? connect(c) : useToken())} />`;
      })}
      ${ready?.github && ready?.githubToken && !(list || []).some((x) => x.service === 'github') && busy !== 'github'
        && html`<${Row} title=${tr('Connect GitHub with a token instead')} sub=${tr('A personal access token you made on GitHub')} onClick=${useToken} />`}
    <//>
    <div class="group-note">${tr('Bots use them when you ask. With Auto-review on, they ask you before sending or deleting email (showing you exactly which emails) and before making a repository public. Deleting email for good, and deleting a repository, always asks. Holly Bot keeps the access encrypted on its server, only for your bots. Disconnect any time.')}</div>`;
}

/** What a computer linked to the account is doing (computerState), in
 * words. `answers`: whether it answered at its address just now. */
function computerStatus(device, answers) {
  const state = computerState(device);
  if (state === 'running') return answers === false ? tr("Running, but this app can't reach it") : tr('Running');
  if (state === 'hidden' && device.tunnel === 'starting') return tr('Running · opening its connection…');
  if (state === 'hidden' && device.tunnel === 'blocked') return tr('Running, but its network blocks the secure tunnel (Cloudflare, port 7844)');
  if (state === 'hidden') return tr("Running without --tunnel, so this app can't reach it");
  if (state === 'old') return tr('Needs the latest Holly Computer (below) before this app can use it');
  return device.seenAt ? tr('Not running · last seen {when}', { when: shortTime(device.seenAt) }) : tr('Not running');
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
  // Whether each running one answers at its address.
  const running = devices.filter((device) => computerConnection(device));
  const answering = useAsync(async () => {
    const answers = await Promise.all(running.map((device) => probeComputer(device.url)));
    return Object.fromEntries(running.map((device, i) => [device.id, answers[i]]));
  }, [running.map((device) => `${device.id}|${device.url}`).join(',')]);
  if (!devices.length) return null;
  const connect = async (device) => {
    if (!computerConnection(device) || busy) return;
    setBusy(device.id);
    try {
      const conn = await reachComputer(device, { latest: async () => (await account.authed('query', 'devices:list')).find((d) => d.id === device.id) });
      chooseComputer(conn, { hello: isPaired(device) ? 'auto' : 'first' });
      location.reload();
    } catch (err) {
      setBusy(null);
      ui.toast(err?.message || tr("Couldn't connect to {name}.", { name: device.name }), { error: true });
    }
  };
  const unlink = async (device) => {
    if (!(await ui.confirm({ title: tr('Unlink {name}?', { name: device.name }), message: tr('{name} stops running your bots and routines. They stay in your account.', { name: device.name }), confirmText: tr('Unlink'), danger: true }))) return;
    try {
      await account.authed('mutation', 'devices:unlink', { id: device.id });
      reload();
    } catch (err) {
      ui.toast(serverSays(err, tr("Couldn't unlink it. Check your connection and try again.")), { error: true });
    }
  };
  const status = (device) => computerStatus(device, answering.data?.[device.id]);
  return html`
    <div class="group-label">${tr('Linked to your account')}</div>
    <${Group}>
      ${devices.map((device) => (device.server
        ? html`<${Row} key=${device.id} title=${device.name} sub=${tr("{status} · your plan's own computer, kept linked by Holly Bot", { status: status(device) })} />`
        : html`<${Row} key=${device.id} title=${device.name}
          sub=${tr('{status} · linked {date}', { status: status(device), date: dateText(device.linkedAt) })} value=${tr('Unlink')} onClick=${() => unlink(device)} />`))}
    <//>
    ${running.map((device) => html`<button key=${device.id} class="btn primary block" style="margin-bottom:10px" disabled=${!!busy} onClick=${() => connect(device)}>
      ${busy === device.id ? html`<span class="spinner"></span>` : html`<${Icon.monitor} size="18" /> ${tr('Connect to {name}', { name: device.name })}`}
    </button>`)}
    <div class="group-note">${tr('While Holly Computer runs on a linked computer, Holly Bot on every device signed in to your account connects to it by itself, and your bots run there with its shell, files, browser, screen, mouse and keyboard.')}</div>`;
}

/** Whether the computer this app controls is the one that comes with the
 * plan, which stays linked to the account and connected (no Unlink or
 * Disconnect for it): Holly Computer says so
 * (computer/src/home.mjs), and so does the account's list of computers
 * (convex/devices.ts). Null until that's known. */
function usePlanServer(app) {
  const ask = !!app.remote && !!app.server?.account?.linked && account.signedIn && signInWorksHere();
  const { data: device } = useAsync(() => (ask
    ? account.authed('query', 'devices:list').then((list) => list.find((d) => sameComputer(d, { device: app.device, name: app.server?.name, url: app.base })) || null)
    : Promise.resolve(null)), [ask]);
  if (app.server?.account?.server) return true;
  if (!ask) return false;
  return device === undefined ? null : !!device?.server;
}

function ComputerPage() {
  const app = useApp();
  const ui = useUi();
  useTopics(['reachable']);
  const planServer = usePlanServer(app);
  const [url, setUrl] = useState('http://localhost:8787');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const scriptUrl = new URL('computer/holly-computer.mjs', location.href).href;

  if (app.remote) {
    const info = app.computer.info || {};
    const caps = info.capabilities || {};
    const name = info.hostname || app.server?.name || tr('your computer');
    return html`
      <div class="welcome" style="padding-bottom:6px">
        <p>${trx('**Your bots live on {name}** and keep working when your phone is locked. This app is the remote control.', { name })}</p>
      </div>
      <div style="margin:0 0 12px"><span class=${`status-pill ${app.reachable ? 'ok' : 'bad'}`}><span class="d"></span>${app.reachable ? tr('Connected') : tr('Reconnecting…')}</span></div>
      <${Group}>
        <${Row} title=${tr('Computer')} value=${info.hostname || '—'} />
        <${Row} title=${tr('System')} value=${info.os || info.platform || '—'} />
        <${Row} title=${tr('Workspace')} value=${info.workspace || '—'} />
        <${Row} title=${tr('Screen & mouse')} value=${caps.desktop ? tr('Yes') : caps.screenshot ? tr('View only') : tr('No')} />
        <${Row} title=${tr('Chrome browser')} value=${caps.browser ? tr('Yes') : tr('Not found')} />
      <//>
      ${info.notes?.length > 0 && html`<div class="group-note">${info.notes.join(' ')}</div>`}
      ${app.server?.account?.linked && html`
        <div class="group-label">${tr('Your account')}</div>
        <${Group}><${Row} title=${tr('Kept in your account')} sub=${tr('Its bots, chats, memories and keys are kept in your Holly Bot account, and {name} runs them. Holly Bot on any device signed in to your account connects to it by itself.', { name })} /><//>`}
      <div class="group-note">${trx("**Keep {name}'s link private, like a password.** Anyone who has it can control {name} and see your bots, chats and files, and a Wi-Fi link opens it without signing in. If a link gets out, restart Holly Computer with --new-token and the old links stop working.", { name })}</div>
      <button class="btn block" onClick=${() => ui.openSheet('computer', { tab: 'screen' })}><${Icon.monitor} size="18" /> ${tr('Open the computer screen')}</button>
      ${app.server?.account?.linked && planServer === false && html`<button class="btn block danger" style="margin-top:10px" onClick=${async () => {
        if (!(await ui.confirm({ title: tr('Unlink {name}?', { name }), message: tr('Your bots stay in your account, and this device switches to them. {name} stops running them until you link it again.', { name }), confirmText: tr('Unlink'), danger: true }))) return;
        try {
          await app.rpc('account.unlink');
        } catch (err) {
          ui.toast(err.message, { error: true });
          return;
        }
        saveConnection(null);
        location.reload();
      }}>${tr('Unlink from My Account')}</button>`}
      ${planServer === false && html`<button class="btn block danger" style="margin-top:10px" onClick=${async () => {
        // A computer linked to the account would be found again as the app
        // reopens, so this device is set to run the bots itself instead.
        const linked = app.server?.account?.linked && account.signedIn && signInWorksHere();
        const message = linked
          ? tr('Your bots stay in your account and {name} keeps running them. This device will run them itself, without {name}, until you connect again here.', { name })
          : account.signedIn && signInWorksHere()
            ? tr('Your bots stay on the computer. This app will switch to the bots in your account.')
            : tr('Your bots stay on the computer. This app will switch to the bots that live in this browser.');
        if (!(await ui.confirm({ title: tr('Disconnect from your computer?'), message, confirmText: tr('Disconnect'), danger: true }))) return;
        if (linked) {
          runHere();
          // Nor does it ask to connect again until the computer restarts.
          const list = await account.authed('query', 'devices:list').catch(() => []);
          const device = list.find((d) => sameComputer(d, { device: app.device, name: app.server?.name, url: app.base }));
          if (device) declineComputer(device);
        } else {
          saveConnection(null);
        }
        location.reload();
      }}>${tr('Disconnect this device')}</button>`}`;
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
        && await ui.confirm({ title: tr('Copy your bots to the computer?'), message: tr('Copy the bots, chats and memories from this browser to your computer so they can keep working there.'), confirmText: tr('Copy them'), cancelText: tr('Start fresh') })) {
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

  const kbd = (text) => html`<span class="kbd">${text}</span>`;
  return html`
    ${app.db?.cloud && html`<${LinkedComputers} />`}
    <div class="welcome" style="padding-bottom:4px">
      ${app.db?.cloud
        ? html`<p>${trx('**Run your bots on your computer.** Link Holly Computer on your PC or Mac to your account and it runs your bots around the clock, using the computer like you would: apps, files, a real browser, the screen, mouse and keyboard. Your bots stay in your account, your phone becomes the remote control, and you approve risky actions from it.')}</p>`
        : html`<p>${trx('**Put your bots on your computer.** Run Holly Computer on your PC or Mac and your bots live there around the clock. They use it like you would: apps, files, a real browser, the screen, mouse and keyboard. Your phone becomes the remote control, and you approve risky actions from it.')}</p>`}
    </div>
    <div class="group" style="padding:14px 18px;font-size:15px;line-height:1.55">
      <p style="margin-top:0">${trx('**Windows:** download {app} on the computer and open it. It installs Holly Computer, which starts with Windows and runs in the taskbar’s corner, with no Node.js or terminal needed. Then sign in on the Holly Bot window it opens.', { app: html`<a href=${WINDOWS_SETUP} rel="noopener">${tr('Holly Computer for Windows')}</a>` })}</p>
      <p>${trx('**Mac, Linux, or Windows from a terminal:**')}</p>
      <p>${trx('1. Install {node} on the computer.', { node: html`<a href="https://nodejs.org" target="_blank" rel="noopener">${tr('Node.js 22 or newer')}</a>` })}</p>
      <p>${trx('2. Download {file} and run it. Or paste this into a terminal:', { file: html`<a href=${scriptUrl} download>holly-computer.mjs</a>` })}</p>
      ${[
        [tr('Mac or Linux (Terminal)'), `curl -fsSLO ${scriptUrl} && node holly-computer.mjs`],
        [tr('Windows (PowerShell)'), `iwr ${scriptUrl} -OutFile holly-computer.mjs; node holly-computer.mjs`],
      ].map(([label, cmd]) => html`
        <div key=${label} style="margin:8px 0 12px">
          <div style="font-size:13px;color:var(--muted);margin-bottom:4px">${label}</div>
          <button class="code-block copyable" title=${tr('Copy')} onClick=${async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              ui.toast(tr('Copied'));
            } catch {
              ui.toast(tr('Couldn’t copy — select the text instead'), { error: true });
            }
          }}>${cmd}</button>
        </div>`)}
      <p>${app.db?.cloud ? tr("3. Sign in on the page it opens on the computer, with the account you use here. Holly Bot here then asks to connect to it, and from then on connects by itself whenever it's running. That's it.") : tr("3. Open the page it opens on the computer. That's it.")}</p>
      <p>${trx('**Keep that link private, like a password.** Anyone who has it can control the computer and see your bots, and a Wi-Fi link opens it without signing in. If a link gets out, restart Holly Computer with --new-token and the old links stop working.')}</p>
      <p style="margin-bottom:0;color:var(--muted);font-size:13.5px">${app.db?.cloud
        ? trx("{tunnel} reaches your computer from anywhere through Cloudflare's free quick tunnel (downloaded automatically the first time); the link changes each time Holly Computer restarts, and once it's linked to your account the app finds the new one by itself. On the same Wi-Fi you can use {lan} instead. Chrome, Edge or Brave on the computer gives bots a real browser. On a Mac, allow your terminal under Privacy & Security → Accessibility and Screen Recording so bots can see and use the screen.", { tunnel: kbd('--tunnel'), lan: kbd('--lan') })
        : trx("{tunnel} reaches your computer from anywhere through Cloudflare's free quick tunnel (downloaded automatically the first time); the link changes each time Holly Computer restarts. On the same Wi-Fi you can use {lan} instead. Chrome, Edge or Brave on the computer gives bots a real browser. On a Mac, allow your terminal under Privacy & Security → Accessibility and Screen Recording so bots can see and use the screen.", { tunnel: kbd('--tunnel'), lan: kbd('--lan') })}</p>
    </div>
    <div class="group-label">${tr('Or connect manually')}</div>
    <${Field} label=${tr('Computer URL')}><input class="input mono" value=${url} autocapitalize="off" onInput=${(e) => setUrl(e.currentTarget.value)} /><//>
    <${Field} label=${tr('Pairing token')}><input class="input mono" type="password" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /><//>
    <button class="btn primary block" disabled=${busy || !url.trim() || !token.trim()} onClick=${connect}>${busy ? html`<span class="spinner"></span>` : tr('Connect')}</button>`;
}

function AppearancePage() {
  const app = useApp();
  return html`<div class="group">${Object.entries(APPEARANCE).map(([k, label]) => html`
    <button class="row" key=${k} onClick=${() => app.saveSettings({ appearance: k })}>
      <div class="label"><div class="t">${tr(label)}</div></div>
      ${(app.settings.appearance || 'system') === k && html`<span class="ok-check"><${Icon.check} /></span>`}
    </button>`)}</div>`;
}

/**
 * Settings → Language: English, Spanish and Chinese at the top, each in its
 * own words (and in the app's, under it), then System, which follows the
 * device's own language. The app changes as soon as one is picked; the bots
 * write in it too (settings.uiLanguage, src/core/prompts.js).
 */
function LanguagePage() {
  const app = useApp();
  const ui = useUi();
  const choice = app.settings.language || 'system';
  const check = html`<span class="ok-check"><${Icon.check} /></span>`;
  const pick = async (next) => {
    const code = await setLanguage(next);
    if (code !== resolveLanguage(next)) {
      ui.toast(tr("Couldn't load that language. Check your connection and try again."), { error: true });
      return;
    }
    await app.saveSettings({ language: next, uiLanguage: code });
  };
  const device = LANGUAGES.find((l) => l.code === resolveLanguage('system'));
  return html`
    <div class="group">${LANGUAGES.map((l) => html`
      <button class="row" key=${l.code} onClick=${() => pick(l.code)}>
        <div class="label"><div class="t" lang=${l.code}>${l.name}</div>${tr(l.english) !== l.name && html`<div class="s">${tr(l.english)}</div>`}</div>
        ${choice === l.code && check}
      </button>`)}</div>
    <div class="group">
      <button class="row" onClick=${() => pick('system')}>
        <div class="label"><div class="t">${tr('System')}</div><div class="s">${tr("This device's language: {language}", { language: device.name })}</div></div>
        ${choice === 'system' && check}
      </button>
    </div>
    <div class="group-note">${tr('Your bots write to you in this language too, and reply in whatever language you write to them.')}</div>`;
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
      const message = {
        computer: mark('Importing replaces all bots, chats, memories and settings on your computer with the backup.'),
        account: mark('Importing replaces all bots, chats, memories and settings in your account with the backup.'),
        browser: mark('Importing replaces all bots, chats, memories and settings in this browser with the backup.'),
      }[home(app)];
      if (!(await ui.confirm({ title: tr('Replace everything?'), message: tr(message), confirmText: tr('Import'), danger: true }))) return;
      try {
        await app.importData(JSON.parse(await file.text()));
        ui.toast(tr('Backup restored'));
        ui.navigate('#/');
      } catch (err) {
        ui.toast(tr('Import failed: {error}', { error: err.message }), { error: true });
      }
    };
    input.click();
  };
  const erase = {
    computer: mark('Deletes all bots, chats, memories, files, routines and keys from your computer. Your account stays.'),
    account: mark('Deletes all bots, chats, memories, files, routines and keys from your account. Your account stays.'),
    browser: mark('Deletes all bots, chats, memories, files, routines and keys from this browser. Your account stays.'),
  }[home(app)];
  return html`
    <${Group}>
      <${Row} title=${tr('Include API keys in export')} toggle=${withKeys} onToggle=${setWithKeys} />
      <${Row} title=${tr('Export backup')} sub=${tr('All bots, chats, memories, files, routines and settings')} onClick=${exportNow} />
      <${Row} title=${tr('Import backup')} onClick=${importNow} />
    <//>
    <div class="group-note">${app.db?.cloud
      ? tr('Everything is kept in your account, on every device you sign in on. A backup is a copy of your own. Treat exports that include keys like passwords.')
      : tr('Use a backup to move Holly Bot to another device or browser. Treat exports that include keys like passwords.')}</div>
    <${Group}>
      <${Row} title=${tr('Pause all routines')} onClick=${async () => {
        const n = await app.routines.setAllEnabled(false);
        ui.toast(trn(n, 'Paused {n} routine', 'Paused {n} routines'));
      }} />
      <${Row} title=${tr('Erase all data')} danger onClick=${async () => {
        if (await ui.confirm({ title: tr('Erase everything?'), message: tr(erase), confirmText: tr('Erase'), danger: true })) {
          await app.resetAll();
          ui.navigate('#/');
          ui.toast(tr('All data erased'));
        }
      }} />
    <//>`;
}

function HelpPage() {
  return html`<div class="bubble plain-bot" style="max-width:100%;line-height:1.5">
    <h3>${tr('Getting started')}</h3>
    <p>${trx('1. Tap **+ → New Bot**, name it and pick a look.')}<br />${tr('2. Chat. Your bot learns about you and remembers across conversations.')}</p>
    <h3>${tr('AI credits')}</h3>
    <p>${trx("Your bots think with Holly Bot's AI, DeepSeek, and your plan comes with **AI credits** for it every month. Settings → **Usage** shows what's left and when they refill. When they run out, your bots pause until the refill.")}</p>
    <h3>${tr('Multiple bots')}</h3>
    <p>${trx('Every bot has its own name, personality, model, memory, files and routines. Bots can **message each other** (“Ask Nova to review this”), **delegate** longer tasks, and share a **team memory**. Start a **group chat** with + → New Group Chat and @mention bots.')}</p>
    <h3>${tr('Memory')}</h3>
    <p>${tr("Tap a bot's name → Memories to see, edit, pin or delete what it knows. Core memory is always in view; long-term memories are recalled when relevant; older chat is summarized automatically.")}</p>
    <p>${trx('What you tell your bots about yourself (your name, how to reach you, what you like) they all remember, and use only to help you: they call you by name and suggest things that fit your taste. Tell any bot to forget something, or what to call you, and they all will. Say “you can learn about me from my emails” to let them learn from the emails they read for you.')}</p>
    <h3>${tr('Tools')}</h3>
    <p>${trx('Web search, a Python/JavaScript sandbox, files, routines and plugins (MCP). Connect a **Bot Computer** for shell, real files, a browser and local plugins. With Auto-review on, risky actions ask for permission first.')}</p>
    <h3>${tr('Email and GitHub')}</h3>
    <p>${trx("Connect **Gmail**, **Outlook** or **GitHub** in Settings → Plugins, then just ask: “Anything from Anna this week?”, “Reply that Friday works”, “Delete last month's newsletters”, “Make a private repo called notes and add a README”. With Auto-review on, you see each email before it goes out and each one before it's deleted. Deleted email goes to the trash, where you can get it back; deleting for good, and deleting a repository, always ask.")}</p>
    <h3>${tr('Your subscription')}</h3>
    <p>${tr("You change your plan, update your card, see invoices or cancel on Stripe. A cancelled plan runs to the end of the period you've paid for, and your bots, chats and memories stay in your account.")}</p>
    <p>${trx("Every plan comes with **your own computer**, a server that runs your bots around the clock and stays linked to your account. The app connects to it by itself, and the **computer button** at the top right shows how it's doing. Upgrading makes it bigger; downgrading moves your bots' files to a smaller one.")}</p>
    <h3>${tr('Install as an app')}</h3>
    <p>${tr('iPhone: Share → Add to Home Screen. Android/desktop Chrome: Install app.')}</p>
    <p><a href="https://github.com/xgamer791/holly-bot#readme" target="_blank" rel="noopener">${tr('Full guide on GitHub ↗')}</a></p>
  </div>`;
}

/** privacy.html or terms.html (the same pages the sign-in screens link to),
 * shown inside Settings. They're in English whatever the app's language. */
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
    ${body && language() !== 'en' && html`<p class="hint" style="margin:4px 4px 10px">${tr('This page is in English.')}</p>`}
    ${body
      ? html`<div class="bubble plain-bot legal-body" lang="en" style="max-width:100%;line-height:1.5" dangerouslySetInnerHTML=${{ __html: body }}></div>`
      : html`<p class="hint">${tr("The {title} couldn't be loaded here.", { title })}</p>`}
    <p style="text-align:center"><a href=${file} target="_blank" rel="noopener">${tr('Open in the browser ↗')}</a></p>`;
}

function PrivacyPage() {
  return html`<${LegalPage} file="privacy.html" title=${tr('Privacy Policy')} />`;
}

function TermsPage() {
  return html`<${LegalPage} file="terms.html" title=${tr('Terms of Service')} />`;
}
