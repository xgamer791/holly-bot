import { html, useState } from '../../vendor/preact.js';
import { Avatar } from './avatar.js';
import { Icon } from './icons.js';
import { LookPicker } from './create-bot.js';
import { AccountLinks } from './subscribe.js';
import { CHIEF } from '../core/chief.js';
import { THINKING_KEYS } from '../core/constants.js';

// The Chief Coordinator's page (src/core/chief.js). An account without one
// gets it as the app opens (src/main.js): it's a new subscriber's first bot,
// made while their server is being set up, and says why it matters. The name
// starts as "Chief Coordinator" and can be changed. With bots already, "Not
// now" puts the page away on this device. `onDone` opens the app.

const POINTS = [
  'Hands each job to the right bot, and does it itself when none fits.',
  'Builds your team: suggests specialist bots for your work, and creates them when you say yes.',
  'Keeps every bot on the same page, and only comes to you for decisions.',
];

export function ChiefScreen({ app, canSkip, onDone, onSkip, onSignOut }) {
  const [name, setName] = useState(CHIEF.name);
  const [shape, setShape] = useState(CHIEF.shape);
  const [color, setColor] = useState(CHIEF.color);
  const [thinking] = useState(() => THINKING_KEYS[Math.floor(Math.random() * THINKING_KEYS.length)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const valid = name.trim().length > 0;

  const create = async () => {
    if (!valid || busy) return;
    const taken = app.findAgent(name.trim());
    if (taken && taken.name.toLowerCase() === name.trim().toLowerCase()) {
      setError('You already have a bot with that name. Pick another one.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const agent = await app.createAgent({ name: name.trim(), shape, color, thinking, role: 'chief', description: CHIEF.description });
      // A Holly Computer from before the Chief Coordinator makes the bot without its role.
      if (agent?.id && agent.role !== 'chief') await app.updateAgent(agent.id, { role: 'chief', description: CHIEF.description });
      onDone(agent);
    } catch (err) {
      console.warn('chief', err);
      setError("Couldn't create it. Check your connection and try again.");
      setBusy(false);
    }
  };

  return html`
    <div class="hello chief-page">
      <div class="hello-canvas">
        <div class="hello-hero device">
          <${Avatar} shape=${shape} color=${color} size=${104} live anim=${thinking} />
          <h1 class="device-title">Meet your Chief Coordinator</h1>
          <p class="device-text">${canSkip
            ? 'Your bots get a lead: the one bot you talk to, which runs all the others for you.'
            : 'Your first bot, and the most important one. It\'s the bot you talk to, and it runs every other bot for you.'}</p>
          <ul class="chief-points">
            ${POINTS.map((text) => html`<li key=${text}><${Icon.check} size=${16} sw=${3} /><span>${text}</span></li>`)}
          </ul>
          <input class="name-input" maxlength="40" value=${name} aria-label="Its name" placeholder="Name it"
            onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} />
          <${LookPicker} shape=${shape} color=${color} onShape=${setShape} onColor=${setColor} />
          ${error && html`<p class="auth-error" role="alert">${error}</p>`}
        </div>
        <div class="hello-dock">
          <div class="hello-ctas">
            <button class="hello-cta" disabled=${!valid || busy} onClick=${create}>${busy ? html`<span class="spinner"></span>` : 'Create'}</button>
          </div>
          ${canSkip && html`<button class="hello-more" disabled=${busy} onClick=${onSkip}>Not now</button>`}
          ${onSignOut && html`<${AccountLinks} busy=${busy} onSignOut=${onSignOut} />`}
        </div>
      </div>
    </div>`;
}
