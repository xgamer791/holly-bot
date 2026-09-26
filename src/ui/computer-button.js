import { html, useEffect, useState } from '../../vendor/preact.js';
import { useApp, useTopics } from './hooks.js';
import { Icon } from './icons.js';
import { mark, tr } from './i18n.js';

// The computer button, at the top right of the bot list and of each chat. It
// opens the computer and shows the connection: grayed out while there's none,
// the computer pulsing blue while it connects, solid green while connected.

/** How long a lost connection to the computer shows as connecting. The app
 * keeps trying after that, but the computer is off as far as anyone can tell. */
const RECONNECT_MS = 30_000;

/** The computer's connection: 'connected', 'connecting' (this app lost it a
 * moment ago and is getting it back, or the plan's server is still being set
 * up: src/main.js), or 'off' (no computer, or gone a while). */
function computerStatus(app, now = Date.now()) {
  if (app.remote && app.reachable === false) return now - (app.unreachableSince || now) < RECONNECT_MS ? 'connecting' : 'off';
  if (app.computer?.connected) return 'connected';
  return app.awaitingServer ? 'connecting' : 'off';
}

const LABEL = { connected: mark('Computer, connected'), connecting: mark('Computer, connecting'), off: mark('Computer, not connected') };

export function ComputerButton({ onClick }) {
  const app = useApp();
  useTopics(['computer', 'reachable']);
  const [, redraw] = useState(0);
  const status = computerStatus(app);
  // Reconnecting goes gray once it has taken a while: look again then.
  useEffect(() => {
    if (status !== 'connecting' || !app.unreachableSince) return undefined;
    const t = setTimeout(() => redraw((n) => n + 1), Math.max(0, app.unreachableSince + RECONNECT_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [status, app.unreachableSince]);
  return html`<button class=${`top-btn computer-btn is-${status}`} aria-label=${tr(LABEL[status])} onClick=${onClick}><${Icon.laptop} /></button>`;
}
