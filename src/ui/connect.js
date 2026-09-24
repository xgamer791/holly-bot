import { html, useState } from '../../vendor/preact.js';
import { Avatar } from './avatar.js';
import { saveConnection } from '../remote/remote-app.js';

/** Shown when the saved Holly Computer can't be reached at startup. */
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
  return html`
    <div class="app mobile"><div class="pane-list"><div class="home-scroll">
      <div class="empty-home" style="padding-top:80px">
        <${Avatar} shape="cloud" color="blue" size=${96} expression="sleepy" />
        <h2>Can't reach your computer</h2>
        <p>Your bots live on ${conn?.name ? `“${conn.name}”` : 'your Holly Computer'}. Make sure it's on and Holly Computer is running${/trycloudflare/.test(conn?.url || '') ? ' (tunnel links change each time it restarts — scan the new QR code)' : ''}.</p>
        <p style="color:var(--red);font-size:14px">${error}</p>
        ${edit && html`<div style="width:100%;max-width:420px;text-align:left">
          <div class="field"><label>Computer URL</label><input class="input mono" value=${url} autocapitalize="off" onInput=${(e) => setUrl(e.currentTarget.value)} /></div>
          <div class="field"><label>Pairing token</label><input class="input mono" type="password" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /></div>
        </div>`}
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary" disabled=${busy} onClick=${retry}>${busy ? html`<span class="spinner"></span>` : 'Try again'}</button>
          <button class="btn" onClick=${() => setEdit(!edit)}>${edit ? 'Hide' : 'Edit connection'}</button>
        </div>
        <button class="btn" style="margin-top:6px" onClick=${() => {
          saveConnection(null);
          location.reload();
        }}>Use bots in this app instead</button>
      </div>
    </div></div></div>`;
}
