import { html, useState, useEffect, useRef } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, useTopics } from './hooks.js';
import { Sheet, Tabs, downloadBlob, Group, Row } from './components.js';
import { Icon, fileIcon } from './icons.js';
import { Markdown } from './markdown.js';
import { formatBytes, formatShort, truncate } from '../core/util.js';
import { fileToBlob, isTextPath } from '../core/files.js';

export function ComputerSheet({ agentId, onClose, fileId: initialFile, tab: initialTab }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['computer', 'settings', 'agents', 'runs']);
  const agent = agentId ? app.getAgent(agentId) : null;
  const connected = app.computer.connected;
  const caps = app.computer.info?.capabilities || {};
  const canScreen = connected && (caps.screenshot || caps.browser);
  const [tab, setTab] = useState(initialTab || (initialFile ? 'files' : canScreen ? 'screen' : agent ? 'files' : 'about'));
  const [openFile, setOpenFile] = useState(initialFile || null);
  const busy = app.runtime.activeRuns().length;
  const tabs = [
    ...(canScreen ? [{ value: 'screen', label: 'Screen' }] : []),
    ...(agent ? [{ value: 'files', label: 'Files' }, { value: 'activity', label: 'Activity' }] : []),
    ...(connected ? [{ value: 'terminal', label: 'Terminal' }] : []),
    { value: 'about', label: connected ? app.computer.info?.hostname || 'Computer' : 'Set up' },
  ];
  return html`
    <${Sheet} title=${agent ? `${agent.name}'s computer` : 'Computer'} onClose=${onClose}
      right=${busy ? html`<button class="btn small danger" onClick=${() => { app.runtime.stopAll(); ui.toast('Stopped all bots'); }}>Stop all</button>`
        : html`<span class=${`status-pill ${connected ? 'ok' : ''}`}><span class="d"></span>${connected ? 'Online' : 'Browser only'}</span>`}>
      <${Tabs} value=${tab} onChange=${(t) => { setTab(t); setOpenFile(null); }} tabs=${tabs} />
      ${tab === 'screen' && html`<${Screen} />`}
      ${tab === 'files' && agent && (openFile
        ? html`<${FilePreview} fileId=${openFile} onBack=${() => setOpenFile(null)} />`
        : html`<${FileList} agentId=${agentId} onOpen=${setOpenFile} />`)}
      ${tab === 'files' && !agent && openFile && html`<${FilePreview} fileId=${openFile} />`}
      ${tab === 'activity' && agent && html`<${ActivityLog} agentId=${agentId} />`}
      ${tab === 'terminal' && html`<${Terminal} />`}
      ${tab === 'about' && html`<${ComputerAbout} onSetup=${() => ui.openSheet('settings', { page: 'computer' })} />`}
    <//>`;
}

function FileList({ agentId, onOpen }) {
  const app = useApp();
  const ui = useUi();
  const input = useRef(null);
  const { data: files = [] } = useAsync(() => app.files.list(agentId), [agentId], [`files:${agentId}`]);
  const upload = async (list) => {
    for (const f of list) {
      await app.files.write(agentId, `uploads/${f.name}`, f, { mime: f.type, source: 'user' });
    }
    ui.toast(`Uploaded ${list.length} file${list.length === 1 ? '' : 's'}`);
  };
  return html`
    <div class="btn-row" style="margin:6px 0 10px">
      <button class="btn small" onClick=${() => input.current.click()}><${Icon.upload} size="16" /> Upload</button>
      <span class="hint" style="align-self:center">${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((s, f) => s + (f.size || 0), 0))}</span>
    </div>
    <input ref=${input} type="file" multiple hidden onChange=${(e) => { upload([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
    ${!files.length && html`<div class="empty-home" style="padding:40px 10px"><p>No files yet. Your bot creates files here when it writes reports, code, charts or images — and you can upload files for it to use.</p></div>`}
    ${files.map((f) => {
      const Ic = fileIcon(f.mime, f.path);
      return html`<button class="file-row" key=${f.id} onClick=${() => onOpen(f.id)}>
        <span class="fi"><${Ic} /></span>
        <span class="n"><div>${f.path}</div><div>${formatBytes(f.size)} · ${formatShort(f.updatedAt)}${f.source === 'user' ? ' · uploaded' : ''}</div></span>
        <${Icon.chevron} size="16" />
      </button>`;
    })}`;
}

export function FilePreview({ fileId, onBack }) {
  const app = useApp();
  const ui = useUi();
  const { data: file, loading } = useAsync(() => app.files.getById(fileId), [fileId]);
  const [url, setUrl] = useState(null);
  const [text, setText] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    let u = null;
    (async () => {
      if (file.text != null) setText(file.text);
      else if (file.blob && isTextPath(file.path, file.mime)) setText(await file.blob.text());
      if (file.blob || /html|svg/.test(file.mime)) {
        u = URL.createObjectURL(await fileToBlob(file));
        setUrl(u);
      }
    })();
    return () => u && URL.revokeObjectURL(u);
  }, [file]);
  if (loading) return html`<div class="notice">Loading…</div>`;
  if (!file) return html`<div class="notice">File not found.</div>`;
  const isImage = file.mime?.startsWith('image/') && file.mime !== 'image/svg+xml';
  const isHtml = /html/.test(file.mime) || /\.html?$/i.test(file.path);
  const isMd = /markdown/.test(file.mime) || /\.md$/i.test(file.path);
  const isPdf = file.mime === 'application/pdf';
  return html`
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px">
      ${onBack && html`<button class="circle-btn" aria-label="Back to files" onClick=${onBack}><${Icon.back} /></button>`}
      <div style="flex:1;min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file.path}</div>
        <div class="hint">${file.mime} · ${formatBytes(file.size)} · ${new Date(file.updatedAt).toLocaleString()}</div></div>
    </div>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn small" onClick=${async () => downloadBlob(await fileToBlob(file), file.path.split('/').pop())}><${Icon.download} size="16" /> Download</button>
      ${(isHtml || isPdf) && url && html`<a class="btn small" href=${url} target="_blank" rel="noopener">Open</a>`}
      <button class="btn small danger" onClick=${async () => {
        if (await ui.confirm({ title: `Delete ${file.path}?`, confirmText: 'Delete', danger: true })) {
          await app.files.remove(file.agentId, file.path);
          onBack?.();
        }
      }}><${Icon.trash} size="16" /> Delete</button>
    </div>
    ${isImage && url && html`<img src=${url} alt=${file.path} style="max-width:100%;border-radius:14px" />`}
    ${isHtml && text != null && html`<iframe class="preview-frame" sandbox="allow-scripts allow-forms allow-modals" srcdoc=${text} title=${file.path}></iframe>`}
    ${isPdf && url && html`<iframe class="preview-frame" src=${url} title=${file.path}></iframe>`}
    ${isMd && text != null && html`<div class="bubble plain-bot" style="max-width:100%"><${Markdown} text=${text} /></div>`}
    ${!isImage && !isHtml && !isMd && !isPdf && text != null && html`<div class="preview-text">${truncate(text, 200000)}</div>`}
    ${!isImage && !isHtml && !isPdf && text == null && html`<div class="notice">No preview for this file type.</div>`}`;
}

function ActivityLog({ agentId }) {
  const app = useApp();
  const { data: rows = [] } = useAsync(() => app.loadActivity(agentId, 150), [agentId], ['activity']);
  if (!rows.length) return html`<div class="empty-home" style="padding:40px 10px"><p>Nothing yet. Tool use, commands, file changes and browsing show up here.</p></div>`;
  return html`${rows.map((r) => html`<div class="act-item" key=${r.id}>
    <div class="when">${formatShort(r.createdAt)}</div>
    <div class="what"><div style=${r.isError ? 'color:var(--red)' : ''}>${r.title}</div>${r.detail && html`<div class="d">${r.detail}</div>`}</div>
  </div>`)}`;
}

function Terminal() {
  const app = useApp();
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  const run = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setCmd('');
    const ctrl = new AbortController();
    setRunning(ctrl);
    setLog((l) => [...l, { t: 'cmd', v: c }]);
    try {
      const res = await app.computer.exec(c, {
        signal: ctrl.signal,
        onData: (stream, chunk) => setLog((l) => [...l, { t: stream, v: chunk }]),
      });
      setLog((l) => [...l, { t: 'exit', v: `[exit ${res.code}]` }]);
    } catch (err) {
      setLog((l) => [...l, { t: 'stderr', v: err.message }]);
    } finally {
      setRunning(null);
    }
  };
  const info = app.computer.info || {};
  return html`
    <div class="hint" style="margin:4px 4px 8px">Commands you type here run on ${info.hostname || 'your computer'} (${info.shell || 'shell'}) in ${info.workspace || info.cwd || 'the workspace'}.</div>
    <div class="terminal" ref=${ref} style="min-height:240px;max-height:48vh">${log.map((e, i) => (e.t === 'cmd'
      ? html`<span key=${i} class="cmd">\n$ ${e.v}\n</span>`
      : html`<span key=${i} class=${e.t === 'stderr' ? 'err' : e.t === 'exit' ? 'cmd' : ''}>${e.v}${e.t === 'exit' ? '\n' : ''}</span>`))}</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input class="input mono" placeholder="Type a command" value=${cmd} onInput=${(e) => setCmd(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && run()} autocapitalize="off" autocorrect="off" spellcheck="false" />
      ${running ? html`<button class="btn" onClick=${() => running.abort()}>Stop</button>` : html`<button class="btn primary" onClick=${run}>Run</button>`}
    </div>`;
}

function Screen() {
  const app = useApp();
  const ui = useUi();
  const caps = app.computer.info?.capabilities || {};
  const [mode, setMode] = useState(caps.screenshot ? 'desktop' : 'browser');
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);
  const [url, setUrl] = useState('');
  const [typing, setTyping] = useState('');
  const [keys, setKeys] = useState('');
  const inflight = useRef(false);

  const show = (r, desktop) => {
    if (desktop) {
      const s = r.screenshot || { data: r.base64, mime: r.mime, width: r.width, height: r.height };
      if (s?.data) setShot({ ...s, mime: s.mime || 'image/jpeg' });
    } else {
      if (r.screenshot) setShot({ data: r.screenshot, mime: 'image/jpeg', width: r.width, height: r.height, url: r.url, title: r.title });
      if (r.url) setUrl(r.url);
    }
  };

  const refresh = async (quiet = false) => {
    if (inflight.current) return;
    inflight.current = true;
    if (!quiet) setBusy(true);
    try {
      if (mode === 'desktop') show(await app.computer.desktopAction('screenshot', { maxWidth: 1280 }), true);
      else show(await app.computer.browser('screenshot'), false);
    } catch (err) {
      if (!quiet) ui.toast(err.message, { error: true });
      setLive(false);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    setShot(null);
    refresh();
  }, [mode]);

  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(true), mode === 'desktop' ? 1500 : 2500);
    return () => clearInterval(t);
  }, [live, mode]);

  const act = async (action, args = {}) => {
    setBusy(true);
    try {
      if (mode === 'desktop') show(await app.computer.desktopAction(action, args), true);
      else {
        const r = await app.computer.browser(action, { ...args, withScreenshot: true });
        show(r.screenshot ? r : await app.computer.browser('screenshot'), false);
      }
    } catch (err) {
      ui.toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  const onTap = (e) => {
    if (!shot?.width) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * shot.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * shot.height);
    if (mode === 'desktop') act('click', { x, y });
    else act('click_xy', { x, y });
  };

  const typeNow = () => {
    if (!typing) return;
    if (mode === 'desktop') act('type', { text: typing });
    else act('type_text', { text: typing });
    setTyping('');
  };
  const press = (k) => (mode === 'desktop' ? act('key', { keys: k }) : act('press', { key: k }));

  return html`
    ${caps.browser && caps.screenshot && html`<div class="segmented" style="margin-bottom:10px">
      <button class=${mode === 'desktop' ? 'on' : ''} onClick=${() => setMode('desktop')}>Desktop</button>
      <button class=${mode === 'browser' ? 'on' : ''} onClick=${() => setMode('browser')}>Bot browser</button></div>`}
    ${mode === 'browser' && html`<div style="display:flex;gap:8px;margin-bottom:10px">
      <input class="input" placeholder="https://" value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && act('goto', { url })} autocapitalize="off" />
      <button class="btn" onClick=${() => act('goto', { url })}>Go</button></div>`}
    <div style="position:relative">
      ${shot?.data ? html`<img class="screen-img" alt="Computer screen — tap to click" src=${`data:${shot.mime};base64,${shot.data}`} onClick=${onTap} />`
        : html`<div class="notice" style="padding:60px 0">${busy ? 'Connecting to the screen…' : 'No picture yet.'}</div>`}
      ${busy && shot?.data && html`<span class="spinner" style="position:absolute;top:10px;right:10px"></span>`}
    </div>
    <div class="hint" style="margin:8px 4px">Tap the picture to click there. ${mode === 'browser' ? 'Sign in to sites here for your bots — logins stay in the bot browser.' : 'This is the live screen of your computer.'}</div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <input class="input" placeholder="Type text…" value=${typing} onInput=${(e) => setTyping(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && typeNow()} autocapitalize="off" autocorrect="off" />
      <button class="btn" onClick=${typeNow}>Type</button>
    </div>
    <div class="btn-row" style="margin-top:8px">
      ${['Enter', 'Tab', 'Escape', 'Backspace'].map((k) => html`<button key=${k} class="btn small" onClick=${() => press(k === 'Escape' && mode === 'desktop' ? 'escape' : k.toLowerCase() === k ? k : mode === 'desktop' ? k.toLowerCase() : k)}>${k === 'Backspace' ? '⌫' : k === 'Escape' ? 'Esc' : k}</button>`)}
      <button class="btn small" onClick=${() => (mode === 'desktop' ? act('scroll', { x: Math.round((shot?.width || 1280) / 2), y: Math.round((shot?.height || 800) / 2), direction: 'up', amount: 5 }) : act('scroll', { direction: 'up' }))}>↑ Scroll</button>
      <button class="btn small" onClick=${() => (mode === 'desktop' ? act('scroll', { x: Math.round((shot?.width || 1280) / 2), y: Math.round((shot?.height || 800) / 2), direction: 'down', amount: 5 }) : act('scroll', { direction: 'down' }))}>↓ Scroll</button>
      ${mode === 'browser' && html`<button class="btn small" onClick=${() => act('back')}>Back</button>`}
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input class="input mono" placeholder=${app.computer.info?.platform === 'darwin' ? 'Shortcut, e.g. cmd+space' : 'Shortcut, e.g. ctrl+l, win'} value=${keys} onInput=${(e) => setKeys(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && keys && (press(keys), setKeys(''))} autocapitalize="off" />
      <button class="btn" disabled=${!keys} onClick=${() => { press(keys); setKeys(''); }}>Press</button>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn small" onClick=${() => setLive(!live)}>${live ? '❚❚ Pause live view' : '▶ Live view'}</button>
      <button class="btn small" disabled=${busy} onClick=${() => refresh()}><${Icon.refresh} size="16" /> Refresh</button>
    </div>`;
}

function ComputerAbout({ onSetup }) {
  const app = useApp();
  const info = app.computer.info;
  if (!app.computer.connected) {
    return html`
      <div class="welcome">
        <p>Right now this bot works entirely in your browser: its own drive, a Python/JavaScript sandbox, web search and memory.</p>
        <p>Connect a <b>Bot Computer</b> — your own PC, Mac, Linux box or server running the small <span class="kbd">holly-computer</span> companion — to let bots run shell commands, edit files, use a real browser and local MCP plugins, with your approval for risky actions.</p>
        ${app.computer.error && html`<p style="color:var(--red)">${app.computer.error}</p>`}
        <button class="btn primary" onClick=${onSetup}>Set up Bot Computer</button>
      </div>`;
  }
  const caps = info?.capabilities || {};
  return html`
    <${Group}>
      <${Row} title="Computer" value=${info?.hostname || '—'} />
      <${Row} title="System" value=${`${info?.os || info?.platform || ''} ${info?.arch || ''}`} />
      <${Row} title="Shell" value=${info?.shell || '—'} />
      <${Row} title="Workspace" value=${info?.workspace || info?.cwd || '—'} />
      <${Row} title="Time zone" value=${info?.tz || '—'} />
    <//>
    <${Group} label="Capabilities">
      ${['shell', 'files', 'fetch', 'search', 'screenshot', 'browser', 'mcp'].map((k) => html`<${Row} key=${k} title=${k} value=${caps[k] ? 'Yes' : 'No'} />`)}
    <//>
    <button class="btn block" onClick=${onSetup}>Connection settings</button>`;
}
