import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useAsync } from './hooks.js';
import { Avatar, botActivity, thinkingOf } from './avatar.js';
import { LookPicker, usePreview } from './create-bot.js';
import { Sheet, Group, Row, Toggle, Field, Segmented } from './components.js';
import { Icon } from './icons.js';
import { AI_MODELS } from '../core/providers/index.js';
import { TOOL_GROUPS } from '../core/constants.js';

export function BotProfileSheet({ agentId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['agents', `memory:${agentId}`, 'routines', 'plugins', 'settings', 'computer', 'connections']);
  const agent = app.getAgent(agentId);
  const [editLook, setEditLook] = useState(false);
  const [preview, play] = usePreview();
  const { data: memCount } = useAsync(() => app.memory.count(agentId), [agentId], [`memory:${agentId}`]);
  const { data: routines } = useAsync(() => app.routines.list(agentId), [agentId], ['routines']);
  if (!agent) return html`<${Sheet} title="Bot" onClose=${onClose}><p>This bot was deleted.</p><//>`;
  const save = (patch) => app.updateAgent(agent.id, patch);
  const channels = app.listThreads({ includeAgentChannels: true }).filter((t) => t.kind === 'agents' && t.agentIds.includes(agent.id));
  const cfgLabel = modelLabel(app, agent);

  return html`
    <${Sheet} title=${agent.name} onClose=${onClose}>
      <div class="create-preview" style="padding:14px 0 18px">
        <button aria-label="Change look" onClick=${() => setEditLook(!editLook)}><${Avatar} shape=${agent.shape} color=${agent.color} size=${120} live activity=${preview ? 'thinking' : botActivity(app, agent)} anim=${thinkingOf(agent)} /></button>
        ${!editLook && html`<div class="hint" style="text-align:center;margin-top:8px">Tap to change the look</div>`}
      </div>
      ${editLook && html`<div style="margin-bottom:28px"><${LookPicker} shape=${agent.shape} color=${agent.color} thinking=${thinkingOf(agent)}
        onShape=${(shape) => save({ shape })} onColor=${(color) => save({ color })} onThinking=${(thinking) => { save({ thinking }); play(); }} /></div>`}
      <${Group}>
        <div class="row"><div class="label"><div class="t">Name</div></div>
          <input type="text" value=${agent.name} maxlength="40" aria-label="Name" onChange=${(e) => e.currentTarget.value.trim() && save({ name: e.currentTarget.value.trim() })} /></div>
        <div class="row"><div class="label"><div class="t">Role</div></div>
          <input type="text" value=${agent.description || ''} placeholder="e.g. Research specialist" aria-label="Role" onChange=${(e) => save({ description: e.currentTarget.value.trim() })} /></div>
      <//>
      <${Field} label="Personality & instructions" hint="How this bot should think, talk and work. Other bots see only its name and role.">
        <textarea class="textarea" placeholder="e.g. You are my coding partner. Be direct, suggest tests, prefer TypeScript." value=${agent.persona || ''}
          onChange=${(e) => save({ persona: e.currentTarget.value })}></textarea>
      <//>
      <${Group} label="Brain">
        <${Row} title="Model" value=${cfgLabel} onClick=${() => ui.openSheet('modelPicker', { agentId })} />
        <div class="row-wrap"><div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
          <div class="label"><div class="t">Reasoning effort</div><div class="s">Higher = smarter, but slower and uses more credits.</div></div>
          <${Segmented} value=${agent.effort || ''} onChange=${(effort) => save({ effort })} options=${[{ value: '', label: 'Auto' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Med' }, { value: 'high', label: 'High' }]} />
        </div></div>
      <//>
      <${Group} label="Memory">
        <${Row} title="Memories" sub="Everything this bot remembers about you" value=${memCount ?? ''} onClick=${() => ui.openSheet('memory', { agentId })} />
        <${Row} title="Learn automatically" sub="Save important facts from every conversation" toggle=${agent.memoryAuto !== false} onToggle=${(v) => save({ memoryAuto: v })} />
      <//>
      <${Group} label="Tools">
        ${Object.entries(TOOL_GROUPS).map(([k, g]) => (k === 'agents' && agent.role === 'chief'
          ? html`<${Row} key=${k} title=${g.label} sub="Always on: the Chief Coordinator runs your other bots" value="On" />`
          : html`<${Row} key=${k} title=${g.label} sub=${toolSub(app, k, g)} toggle=${agent.tools?.[k] !== false} onToggle=${(v) => save({ tools: { ...(agent.tools || {}), [k]: v } })} />`))}
      <//>
      ${app.plugins.list().some((p) => p.status === 'ok') && html`<${Group} label="Plugins">
        ${app.plugins.list().filter((p) => p.status === 'ok').map((p) => html`<${Row} key=${p.key} title=${p.name} sub=${`${p.tools.length} tools${p.via === 'computer' ? ' · via Bot Computer' : ''}`}
          toggle=${agent.plugins?.[p.name] !== false} onToggle=${(v) => save({ plugins: { ...(agent.plugins || {}), [p.name]: v } })} />`)}
      <//>`}
      <${Group} label="Work">
        <${Row} title="Routines" sub="Scheduled tasks this bot runs" value=${routines?.length || ''} onClick=${() => ui.openSheet('routines', { agentId })} />
        <${Row} title="Files & Computer" sub="Its drive, activity and your Bot Computer" onClick=${() => ui.openSheet('computer', { agentId })} />
        ${Object.keys(agent.alwaysAllow || {}).length > 0 && html`<${Row} title="Always-allowed actions" sub=${Object.keys(agent.alwaysAllow).join(', ')} value="Reset" onClick=${() => save({ alwaysAllow: {} })} />`}
      <//>
      ${channels.length > 0 && html`<${Group} label="Conversations with other bots">
        ${channels.map((t) => {
          const other = app.getAgent(t.agentIds.find((id) => id !== agent.id));
          return html`<${Row} key=${t.id} icon=${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${30} />`} title=${other?.name || 'Bot'} sub=${t.preview?.text || ''}
            onClick=${() => { onClose(); ui.navigate(`#/chat/${t.id}`); }} />`;
        })}
      <//>`}
      <${Group}>
        <${Row} title="Clear chat" sub="Deletes messages; memories stay" onClick=${async () => {
          if (await ui.confirm({ title: `Clear chat with ${agent.name}?`, message: 'Messages will be deleted. The bot keeps its long-term memory.', confirmText: 'Clear', danger: true })) {
            await app.clearThread(`dm_${agent.id}`);
            ui.toast('Chat cleared');
          }
        }} />
        <${Row} title=${`Delete ${agent.name}`} danger onClick=${async () => {
          if (await ui.confirm({ title: `Delete ${agent.name}?`, message: 'This deletes the bot, its chats, memories, files and routines. This cannot be undone.', confirmText: 'Delete', danger: true })) {
            onClose();
            ui.navigate('#/');
            await app.deleteAgent(agent.id);
          }
        }} />
      <//>
    <//>`;
}

function toolSub(app, key, g) {
  if (key === 'computer' && !app.computer.connected) return `${g.description} (not connected)`;
  if (key === 'images' && !app.providers.imageProvider()) return `${g.description} (not available with Holly Bot's AI)`;
  if (key === 'plugins' && !app.plugins.list().some((p) => p.status === 'ok')) return `${g.description} (none connected)`;
  if ((key === 'email' || key === 'github') && app.connection) {
    const accounts = (key === 'email' ? ['gmail', 'outlook'] : ['github']).map((s) => app.connection(s)?.account).filter(Boolean);
    return accounts.length ? `${g.description} · ${accounts.join(', ')}` : `${g.description} (connect ${key === 'email' ? 'Gmail or Outlook' : 'GitHub'} in Settings → Plugins)`;
  }
  return g.description;
}

/** What Holly Bot's AI models are called in the app. */
export const MODEL_NAMES = { 'glm-flash': 'GLM 5.3 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };

/** What each costs in credits, next to the other. */
const MODEL_NOTES = { 'glm-flash': 'Smart, fast and light on credits', 'deepseek-v4-pro': 'Deeper thinking; uses credits several times as fast' };

export function modelLabel(app, agent) {
  try {
    const cfg = app.providers.resolve(agent);
    return MODEL_NAMES[cfg.model] || (cfg.model === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : cfg.model);
  } catch {
    return MODEL_NAMES[agent.model] || MODEL_NAMES[AI_MODELS[0]];
  }
}

/** A bot's brain: one of Holly Bot's AI models, paid for with the account's
 * credits (src/core/providers). Flash unless the bot picks Pro. */
export function ModelPickerSheet({ agentId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['settings', 'agents']);
  const agent = agentId ? app.getAgent(agentId) : null;
  const current = AI_MODELS.includes(agent ? agent.model : app.settings.defaults?.model) ? (agent ? agent.model : app.settings.defaults.model) : AI_MODELS[0];

  const choose = async (model) => {
    if (agent) await app.updateAgent(agent.id, { provider: 'deepseek', model });
    else await app.saveSettings({ defaults: { ...app.settings.defaults, provider: 'deepseek', model } });
    ui.toast(`Using ${MODEL_NAMES[model]}`);
    onClose();
  };

  return html`
    <${Sheet} title=${agent ? `${agent.name}'s model` : 'Default model'} onClose=${onClose}>
      <div class="group">
        ${AI_MODELS.map((m) => html`<button key=${m} class="row" onClick=${() => choose(m)}>
          <div class="label"><div class="t" style="font-size:16px">${MODEL_NAMES[m]}</div><div class="s">${MODEL_NOTES[m]}</div></div>
          ${current === m && html`<span class="ok-check"><${Icon.check} /></span>`}
        </button>`)}
      </div>
      <div class="group-note">Both run on your plan's AI credits (Settings → Usage).</div>
    <//>`;
}

export { Toggle };
