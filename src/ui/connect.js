import { html, useState } from '../../vendor/preact.js';
import { Avatar } from './avatar.js';
import { saveConnection } from '../remote/remote-app.js';
import { tr } from './i18n.js';

/** Shown when the saved Holly Bot Computer can't be reached at startup. */
export function ConnectProblem({ conn, error, onRetry }) {
  const [url, setUrl] = useState(conn?.url || '');
  const [token, setToken] = useState(conn?.token || '');
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    saveConnection({ ...conn, url: url.trim(), token: token.trim() });
    await onRetry();
    setBusy(false);
  };
  const tunnel = /trycloudflare/.test(conn?.url || '');
  return html`
    <div class="app mobile"><div class="pane-list"><div class="home-scroll">
      <div class="empty-home" style="padding-top:80px">
        <${Avatar} shape="cloud" color="blue" size=${96} expression="sleepy" />
        <h2>${tr("Can't reach your computer")}</h2>
        <p>${conn?.name
          ? tunnel
            ? tr("Your bots live on “{name}”. Make sure it's on and Holly Bot Computer is running. Its address changes each time it restarts: sign in on the page it opens on the computer, and this app finds it wherever it is.", { name: conn.name })
            : tr("Your bots live on “{name}”. Make sure it's on and Holly Bot Computer is running.", { name: conn.name })
          : tunnel
            ? tr("Your bots live on your Holly Bot Computer. Make sure it's on and Holly Bot Computer is running. Its address changes each time it restarts: sign in on the page it opens on the computer, and this app finds it wherever it is.")
            : tr("Your bots live on your Holly Bot Computer. Make sure it's on and Holly Bot Computer is running.")}</p>
        <p style="color:var(--red);font-size:14px">${error}</p>
        ${edit && html`<div style="width:100%;max-width:420px;text-align:left">
          <div class="field"><label>${tr('Computer URL')}</label><input class="input mono" value=${url} autocapitalize="off" onInput=${(e) => setUrl(e.currentTarget.value)} /></div>
          <div class="field"><label>${tr('Pairing token')}</label><input class="input mono" type="password" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /></div>
        </div>`}
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary" disabled=${busy} onClick=${retry}>${busy ? html`<span class="spinner"></span>` : tr('Try again')}</button>
          <button class="btn" onClick=${() => setEdit(!edit)}>${edit ? tr('Hide') : tr('Edit connection')}</button>
        </div>
        <button class="btn" style="margin-top:6px" onClick=${() => {
          saveConnection(null);
          location.reload();
        }}>${tr('Use bots in this app instead')}</button>
      </div>
    </div></div></div>`;
}
