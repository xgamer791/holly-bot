import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useAsync, haptic } from './hooks.js';
import { Sheet, Segmented } from './components.js';
import { Icon } from './icons.js';
import { account } from '../account/account.js';
import { RemoteApp, computerConnection, computerState, sameComputer, saveConnection } from '../remote/remote-app.js';
import { formatShort } from '../core/util.js';

// A chat's workspace (thread.workspace): what its bot works on. GitHub
// repositories (as many as you like), or one server (a computer linked to the
// account, running Holly Computer) and, if you like, some of its apps. Never
// both: picking one side clears the other. The bot's tools and instructions
// follow (src/core/tools/index.js, src/core/prompts.js). Opened from the
// Workspace button in the prompt bar (src/ui/composer.js).
//
//   { kind: 'github', repos: ['owner/name', …] }
//   { kind: 'server', device, name, apps: [{ name, kind, path? , image? }, …] }

export function WorkspaceSheet({ threadId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', `thread:${threadId}`]);
  const thread = app.getThread(threadId);
  const ws = thread?.workspace || null;
  const [tab, setTab] = useState(ws?.kind === 'server' ? 'server' : 'github');
  const bot = thread?.kind === 'dm' ? app.getAgent(thread.agentIds[0])?.name : null;

  const save = async (next) => {
    haptic(app);
    try {
      await app.updateThread(threadId, { workspace: next });
    } catch (err) {
      ui.toast(err?.message || "Couldn't save the workspace.", { error: true });
    }
  };

  return html`
    <${Sheet} title="Workspace" onClose=${onClose} className="ws-sheet"
      footer=${ws ? html`<button class="btn block" onClick=${() => save(null)}>Clear Workspace</button>` : null}>
      <p class="ws-lead">${bot ? `What ${bot} works on in this chat` : 'What the bots work on in this chat'}: GitHub repositories, or a server. One or the other, never both.</p>
      <${Segmented} value=${tab} onChange=${setTab} options=${[{ value: 'github', label: 'GitHub' }, { value: 'server', label: 'Server' }]} />
      ${tab === 'github' ? html`<${GitHubPane} ws=${ws} save=${save} />` : html`<${ServerPane} ws=${ws} save=${save} />`}
    <//>`;
}

function GitHubPane({ ws, save }) {
  const ui = useUi();
  const signedIn = account.signedIn;
  const conns = useAsync(() => (signedIn ? account.authed('query', 'connectors:list') : Promise.resolve([])), [signedIn]);
  const gh = (conns.data || []).find((c) => c.service === 'github');
  const repos = useAsync(
    () => (gh ? account.authed('action', 'connectors:run', { service: 'github', op: 'list_repos', args: { max: 100 } }) : Promise.resolve([])),
    [gh?.account],
  );
  const [query, setQuery] = useState('');
  const chosen = ws?.kind === 'github' ? ws.repos || [] : [];

  if (conns.loading && !conns.data) return html`<div class="ws-empty"><span class="spinner"></span></div>`;
  if (!gh) {
    return html`
      <div class="ws-empty">
        <span class="ws-empty-icon"><${Icon.github} size="28" /></span>
        <b>Connect GitHub</b>
        <p>Connect your GitHub account, then pick the repositories this chat works on.</p>
        <button class="btn primary" onClick=${() => ui.openSheet('settings', { page: 'plugins' })}>Connect GitHub</button>
      </div>`;
  }

  const toggle = (repo) => {
    const next = chosen.includes(repo) ? chosen.filter((r) => r !== repo) : [...chosen, repo];
    save(next.length ? { kind: 'github', repos: next } : null);
  };
  const list = repos.data || [];
  const q = query.trim().toLowerCase();
  const matches = list.filter((r) => !q || r.repo.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
  // What's picked stays on top, even when it isn't among the newest 100.
  const missing = chosen.filter((repo) => !list.some((r) => r.repo === repo) && (!q || repo.toLowerCase().includes(q))).map((repo) => ({ repo }));
  const rows = [...missing, ...matches.filter((r) => chosen.includes(r.repo)), ...matches.filter((r) => !chosen.includes(r.repo))];

  return html`
    ${ws?.kind === 'server' && html`<p class="ws-note">This chat works on ${ws.name} now. Picking a repository switches it to GitHub.</p>`}
    <div class="ws-head"><${Icon.github} size="15" /> ${gh.account}${chosen.length > 0 && html`<span class="ws-count">${chosen.length} picked</span>`}</div>
    ${list.length > 6 && html`
      <div class="search-bar ws-search"><${Icon.search} />
        <input placeholder="Search repositories" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} autocapitalize="off" autocorrect="off" />
      </div>`}
    ${repos.loading && !repos.data && html`<div class="ws-empty"><span class="spinner"></span></div>`}
    ${repos.error && html`<p class="ws-note">Couldn't load your repositories. <button class="ws-link" onClick=${repos.reload}>Try again</button></p>`}
    ${rows.length > 0 && html`
      <div class="ws-list">
        ${rows.map((r) => {
          const on = chosen.includes(r.repo);
          const [owner, name] = r.repo.split('/');
          return html`
            <button key=${r.repo} class=${`ws-row ${on ? 'on' : ''}`} role="checkbox" aria-checked=${on} onClick=${() => toggle(r.repo)}>
              <span class="ws-check">${on && html`<${Icon.check} size="14" />`}</span>
              <span class="ws-text">
                <span class="ws-title">${name}${r.private && html`<${Icon.lock} size="13" class="ws-lock" />`}</span>
                <span class="ws-sub">${owner}${r.description ? ` · ${r.description}` : ''}</span>
              </span>
              ${r.updated && html`<span class="ws-when">${formatShort(Date.parse(r.updated))}</span>`}
            </button>`;
        })}
      </div>`}
    ${!repos.loading && !repos.error && !rows.length && html`<p class="ws-note">${q ? `No repositories match “${query}”.` : `No repositories on ${gh.account} yet.`}</p>`}`;
}

function ServerPane({ ws, save }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['computer', 'reachable']);
  const signedIn = account.signedIn;
  const devices = useAsync(() => (signedIn ? account.authed('query', 'devices:list') : Promise.resolve([])), [signedIn]);
  const [busy, setBusy] = useState(null);
  const here = app.remote ? { device: app.device, name: app.server?.name, url: app.base } : null;
  // Your own computers first, then the server that comes with your plan.
  const list = [...(devices.data || [])].sort((a, b) => Number(!!a.server) - Number(!!b.server));
  // A computer this app controls that isn't linked to the account.
  if (app.computer?.connected && !list.some((d) => here && sameComputer(d, here))) {
    const info = app.computer.info || {};
    list.unshift({ id: null, name: info.name || info.hostname || 'This computer', local: true });
  }
  const isHere = (d) => d.local || (!!here && sameComputer(d, here));
  const picked = (d) => ws?.kind === 'server' && (d.id ? ws.device === d.id : ws.name === d.name);
  const current = list.find(picked);

  const pick = async (d) => {
    if (picked(d)) return;
    if (isHere(d)) {
      save({ kind: 'server', device: d.id, name: d.name, apps: [] });
      return;
    }
    const conn = computerConnection(d);
    if (!conn) {
      ui.toast(`${d.name} is off. Start Holly Computer on it, then pick it here.`);
      return;
    }
    if (!(await ui.confirm({
      title: `Connect to ${d.name}?`,
      message: `Your bots run on ${d.name} from now on, in every chat, and this chat works on it.`,
      confirmText: 'Connect',
    }))) return;
    setBusy(d.id);
    try {
      const remote = new RemoteApp(conn);
      await remote.connect();
      remote.close();
      await save({ kind: 'server', device: d.id, name: d.name, apps: [] });
      await app.db?.drain?.(5000)?.catch?.(() => {});
      saveConnection({ ...conn, name: remote.server?.name || d.name });
      location.reload();
    } catch (err) {
      setBusy(null);
      ui.toast(`Couldn't reach ${d.name}. ${err?.message || ''}`.trim(), { error: true });
    }
  };

  if (devices.loading && !devices.data && !list.length) return html`<div class="ws-empty"><span class="spinner"></span></div>`;
  if (!list.length) {
    return html`
      <div class="ws-empty">
        <span class="ws-empty-icon"><${Icon.server} size="28" /></span>
        <b>No servers yet</b>
        <p>Run Holly Computer on a computer or server and link it to your account. Then pick it here.</p>
        <button class="btn primary" onClick=${() => ui.openSheet('settings', { page: 'computer' })}>Set Up Holly Computer</button>
      </div>`;
  }

  return html`
    ${ws?.kind === 'github' && html`<p class="ws-note">This chat works on GitHub now. Picking a server switches it.</p>`}
    <div class="ws-list">
      ${list.map((d) => {
        const on = picked(d);
        return html`
          <button key=${d.id || 'here'} class=${`ws-row ${on ? 'on' : ''}`} role="radio" aria-checked=${on} disabled=${!!busy} onClick=${() => pick(d)}>
            <span class="ws-radio">${on && html`<span></span>`}</span>
            <span class="ws-icon"><${Icon.server} size="18" /></span>
            <span class="ws-text">
              <span class="ws-title">${d.name}</span>
              <span class="ws-sub">${serverStatus(d, isHere(d))}${d.server ? " · your plan's server" : ''}</span>
            </span>
            ${busy === d.id && html`<span class="spinner"></span>`}
          </button>`;
      })}
    </div>
    ${current && isHere(current) && html`<${AppsPane} ws=${ws} save=${save} />`}
    ${current && !isHere(current) && html`<p class="ws-note">This app isn't connected to ${current.name}, so its bots can't work there yet. Tap it to connect.</p>`}`;
}

function serverStatus(d, here) {
  if (here) return 'Connected';
  const state = computerState(d);
  if (state === 'running') return computerConnection(d) ? 'On' : "On, but this app can't reach it";
  if (state === 'hidden') return "On, but this app can't reach it";
  if (state === 'old') return 'Needs the latest Holly Computer';
  return d.seenAt ? `Off · seen ${formatShort(d.seenAt)}` : 'Off';
}

/** The apps on the server this app is connected to (computer/src/apps.mjs). */
function AppsPane({ ws, save }) {
  const app = useApp();
  const apps = useAsync(() => app.computer.apps(), [app.computer?.url]);
  const chosen = ws.apps || [];
  const key = (a) => a.path || `container:${a.name}`;
  const home = app.computer?.info?.home;
  const short = (path) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const toggle = (a) => {
    const on = chosen.some((c) => key(c) === key(a));
    const next = on
      ? chosen.filter((c) => key(c) !== key(a))
      : [...chosen, { name: a.name, kind: a.kind, ...(a.path ? { path: a.path } : {}), ...(a.image ? { image: a.image } : {}) }];
    save({ ...ws, apps: next });
  };
  const list = apps.data || [];
  // Picked apps it didn't find this time (moved, or a container that stopped) stay listed.
  const gone = chosen.filter((c) => !list.some((a) => key(a) === key(c)));
  const rows = [...gone, ...list];
  const old = /Unknown endpoint/.test(apps.error?.message || '');

  return html`
    <div class="group-label ws-apps-label">Apps on ${ws.name}</div>
    <p class="ws-lead small">Pick apps to keep the bot to them, or none for the whole server.</p>
    ${apps.loading && !apps.data && html`<div class="ws-empty"><span class="spinner"></span></div>`}
    ${apps.error && html`<p class="ws-note">${old ? 'Restart Holly Computer on it to update it, and its apps show up here.' : "Couldn't look for its apps."}
      ${!old && html` <button class="ws-link" onClick=${apps.reload}>Try again</button>`}</p>`}
    ${rows.length > 0 && html`
      <div class="ws-list">
        ${rows.map((a) => {
          const on = chosen.some((c) => key(c) === key(a));
          return html`
            <button key=${key(a)} class=${`ws-row ${on ? 'on' : ''}`} role="checkbox" aria-checked=${on} onClick=${() => toggle(a)}>
              <span class="ws-check">${on && html`<${Icon.check} size="14" />`}</span>
              <span class="ws-icon">${a.path ? html`<${Icon.folder} size="18" />` : html`<${Icon.box} size="18" />`}</span>
              <span class="ws-text">
                <span class="ws-title">${a.name}${a.kind && html`<span class="ws-kind">${a.kind}</span>`}</span>
                <span class="ws-sub">${a.path ? short(a.path) : [a.image, a.status].filter(Boolean).join(' · ')}${a.repo ? ` · ${a.repo}` : ''}</span>
              </span>
            </button>`;
        })}
      </div>`}
    ${!apps.loading && !apps.error && !rows.length && html`<p class="ws-note">No apps found in its usual folders. The bot can still work on the whole server.</p>`}`;
}
