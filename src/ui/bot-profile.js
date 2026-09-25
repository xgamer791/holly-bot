import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useAsync } from './hooks.js';
import { Avatar, botActivity, thinkingOf } from './avatar.js';
import { AgentText, LookPicker, usePreview } from './create-bot.js';
import { briefCurrent, jobSummary } from '../core/brief.js';
import { Sheet, Group, Row, Toggle, Field, Segmented } from './components.js';
import { Icon } from './icons.js';
import { AI_MODELS } from '../core/providers/index.js';
import { TOOL_GROUPS } from '../core/constants.js';
import { mark, phraseOr, tr, trn } from './i18n.js';

export function BotProfileSheet({ agentId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['agents', `memory:${agentId}`, 'routines', 'plugins', 'settings', 'computer', 'connections']);
  const agent = app.getAgent(agentId);
  const [editLook, setEditLook] = useState(false);
  const [preview, play] = usePreview();
  const { data: memCount } = useAsync(() => app.memory.count(agentId), [agentId], [`memory:${agentId}`]);
  const { data: routines } = useAsync(() => app.routines.list(agentId), [agentId], ['routines']);
  if (!agent) return html`<${Sheet} title=${tr('Bot')} onClose=${onClose}><p>${tr('This bot was deleted.')}</p><//>`;
  const save = (patch) => app.updateAgent(agent.id, patch);
  const channels = app.listThreads({ includeAgentChannels: true }).filter((t) => t.kind === 'agents' && t.agentIds.includes(agent.id));
  const cfgLabel = modelLabel(app, agent);
  const chief = agent.role === 'chief';

  return html`
    <${Sheet} title=${agent.name} onClose=${onClose}>
      <div class="create-preview" style="padding:14px 0 18px">
        <button aria-label=${tr('Change look')} onClick=${() => setEditLook(!editLook)}><${Avatar} shape=${agent.shape} color=${agent.color} size=${120} live activity=${preview ? 'thinking' : botActivity(app, agent)} anim=${thinkingOf(agent)} /></button>
        ${!editLook && html`<div class="hint" style="text-align:center;margin-top:8px">${tr('Tap to change the look')}</div>`}
      </div>
      ${editLook && html`<div style="margin-bottom:28px"><${LookPicker} shape=${agent.shape} color=${agent.color} thinking=${thinkingOf(agent)}
        onShape=${(shape) => save({ shape })} onColor=${(color) => save({ color })} onThinking=${(thinking) => { save({ thinking }); play(); }} /></div>`}
      <${Group}>
        <div class="row"><div class="label"><div class="t">${tr('Name')}</div></div>
          <input type="text" value=${agent.name} maxlength="40" aria-label=${tr('Name')} onChange=${(e) => e.currentTarget.value.trim() && save({ name: e.currentTarget.value.trim() })} /></div>
      <//>
      <${Field} label=${tr('Job')} hint=${!chief && tr("What it's for, in your words. It keeps this in its memory and reads it before every chat, and Holly Bot's AI briefs it on it.")}>
        <${AgentText} key=${`job_${agent.id}`} agent=${agent} field="description" summary=${jobSummary(agent)} label=${tr("Bot's job")}
          placeholder=${tr('e.g. Plan my meals for the week and make the shopping list')} />
      <//>
      ${!chief && agent.description?.trim() && html`<${Briefing} agent=${agent} />`}
      <${Field} label=${tr('Rules')} hint=${tr("Hard rules it must always follow, in your words. It keeps them in its memory and reads them before every chat. If one goes against Holly Bot's own safety and behavior rules, it won't follow that one, and it will tell you why in your chat.")}>
        <${AgentText} key=${`rules_${agent.id}`} agent=${agent} field="rules" rules label=${tr("Bot's rules")}
          placeholder=${tr('e.g. Never send an email without my OK')} />
      <//>
      <${Field} label=${tr('Personality & instructions')} hint=${tr('How this bot should think, talk and work. Other bots see only its name and job.')}>
        <textarea class="textarea" placeholder=${tr('e.g. You are my coding partner. Be direct, suggest tests, prefer TypeScript.')} value=${agent.persona || ''}
          onChange=${(e) => save({ persona: e.currentTarget.value })}></textarea>
      <//>
      <${Group} label=${tr('Brain')}>
        <${Row} title=${tr('Model')} value=${cfgLabel} onClick=${() => ui.openSheet('modelPicker', { agentId })} />
        <div class="row-wrap"><div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
          <div class="label"><div class="t">${tr('Reasoning effort')}</div><div class="s">${tr('Higher = smarter, but slower and uses more credits.')}</div></div>
          <${Segmented} value=${agent.effort || ''} onChange=${(effort) => save({ effort })} options=${[{ value: '', label: tr('Auto') }, { value: 'low', label: tr('Low') }, { value: 'medium', label: tr('Med') }, { value: 'high', label: tr('High') }]} />
        </div></div>
      <//>
      <${Group} label=${tr('Memory')}>
        <${Row} title=${tr('Memories')} sub=${tr('Everything this bot remembers about you')} value=${memCount ?? ''} onClick=${() => ui.openSheet('memory', { agentId })} />
        <${Row} title=${tr('Learn automatically')} sub=${tr('Save important facts from every conversation')} toggle=${agent.memoryAuto !== false} onToggle=${(v) => save({ memoryAuto: v })} />
      <//>
      <${Group} label=${tr('Tools')}>
        ${Object.entries(TOOL_GROUPS).map(([k, g]) => (k === 'agents' && agent.role === 'chief'
          ? html`<${Row} key=${k} title=${tr(g.label)} sub=${tr('Always on: the Chief Coordinator runs your other bots')} value=${tr('On')} />`
          : html`<${Row} key=${k} title=${tr(g.label)} sub=${toolSub(app, k, g)} toggle=${agent.tools?.[k] !== false} onToggle=${(v) => save({ tools: { ...(agent.tools || {}), [k]: v } })} />`))}
      <//>
      ${app.plugins.list().some((p) => p.status === 'ok') && html`<${Group} label=${tr('Plugins')}>
        ${app.plugins.list().filter((p) => p.status === 'ok').map((p) => html`<${Row} key=${p.key} title=${p.name} sub=${p.via === 'computer' ? trn(p.tools.length, '{n} tool · via Bot Computer', '{n} tools · via Bot Computer') : trn(p.tools.length, '{n} tool', '{n} tools')}
          toggle=${agent.plugins?.[p.name] !== false} onToggle=${(v) => save({ plugins: { ...(agent.plugins || {}), [p.name]: v } })} />`)}
      <//>`}
      <${Group} label=${tr('Work')}>
        <${Row} title=${tr('Routines')} sub=${tr('Scheduled tasks this bot runs')} value=${routines?.length || ''} onClick=${() => ui.openSheet('routines', { agentId })} />
        <${Row} title=${tr('Files & Computer')} sub=${tr('Its drive, activity and your Bot Computer')} onClick=${() => ui.openSheet('computer', { agentId })} />
        ${Object.keys(agent.alwaysAllow || {}).length > 0 && html`<${Row} title=${tr('Always-allowed actions')} sub=${Object.keys(agent.alwaysAllow).join(', ')} value=${tr('Reset')} onClick=${() => save({ alwaysAllow: {} })} />`}
      <//>
      ${channels.length > 0 && html`<${Group} label=${tr('Conversations with other bots')}>
        ${channels.map((t) => {
          const other = app.getAgent(t.agentIds.find((id) => id !== agent.id));
          return html`<${Row} key=${t.id} icon=${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${30} />`} title=${other?.name || tr('Bot')} sub=${phraseOr(t.preview?.say, t.preview?.text || '')}
            onClick=${() => { onClose(); ui.navigate(`#/chat/${t.id}`); }} />`;
        })}
      <//>`}
      <${Group}>
        <${Row} title=${tr('Clear chat')} sub=${tr('Deletes messages; memories stay')} onClick=${async () => {
          if (await ui.confirm({ title: tr('Clear chat with {name}?', { name: agent.name }), message: tr('Messages will be deleted. The bot keeps its long-term memory.'), confirmText: tr('Clear'), danger: true })) {
            await app.clearThread(`dm_${agent.id}`);
            ui.toast(tr('Chat cleared'));
          }
        }} />
        <${Row} title=${tr('Delete {name}', { name: agent.name })} danger onClick=${async () => {
          if (await ui.confirm({ title: tr('Delete {name}?', { name: agent.name }), message: tr('This deletes the bot, its chats, memories, files and routines. This cannot be undone.'), confirmText: tr('Delete'), danger: true })) {
            onClose();
            ui.navigate('#/');
            await app.deleteAgent(agent.id);
          }
        }} />
      <//>
    <//>`;
}

/** The briefing Holly Bot's AI wrote the bot from its job and rules
 * (src/core/brief.js), folded away until it's opened; while it's being
 * written, a note saying so. */
function Briefing({ agent }) {
  if (!briefCurrent(agent)) return html`<div class="brief-note">${tr('Writing its briefing…')}</div>`;
  return html`
    <details class="brief">
      <summary>${tr('Its briefing')}<${Icon.down} size="18" /></summary>
      <div class="brief-text">${agent.brief}</div>
    </details>`;
}

function toolSub(app, key, g) {
  const description = tr(g.description);
  if (key === 'computer' && !app.computer.connected) return tr('{description} (not connected)', { description });
  if (key === 'images' && !app.providers.imageProvider()) return tr("{description} (not available with Holly Bot's AI)", { description });
  if (key === 'plugins' && !app.plugins.list().some((p) => p.status === 'ok')) return tr('{description} (none connected)', { description });
  if ((key === 'email' || key === 'github') && app.connection) {
    const accounts = (key === 'email' ? ['gmail', 'outlook'] : ['github']).map((s) => app.connection(s)?.account).filter(Boolean);
    if (accounts.length) return `${description} · ${accounts.join(', ')}`;
    return key === 'email'
      ? tr('{description} (connect Gmail or Outlook in Settings → Plugins)', { description })
      : tr('{description} (connect GitHub in Settings → Plugins)', { description });
  }
  return description;
}

/** What Holly Bot's AI models are called in the app. */
export const MODEL_NAMES = { 'deepseek-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };

/** What each costs in credits, next to the other. */
const MODEL_NOTES = { 'deepseek-flash': mark('Smart, fast and light on credits'), 'deepseek-v4-pro': mark('Deeper thinking; uses credits about 4× as fast') };

export function modelLabel(app, agent) {
  try {
    const cfg = app.providers.resolve(agent);
    return MODEL_NAMES[cfg.model] || cfg.model;
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
    ui.toast(tr('Using {model}', { model: MODEL_NAMES[model] }));
    onClose();
  };

  return html`
    <${Sheet} title=${agent ? tr("{name}'s model", { name: agent.name }) : tr('Default model')} onClose=${onClose}>
      <div class="group">
        ${AI_MODELS.map((m) => html`<button key=${m} class="row" onClick=${() => choose(m)}>
          <div class="label"><div class="t" style="font-size:16px">${MODEL_NAMES[m]}</div><div class="s">${tr(MODEL_NOTES[m])}</div></div>
          ${current === m && html`<span class="ok-check"><${Icon.check} /></span>`}
        </button>`)}
      </div>
      <div class="group-note">${tr("Both run on your plan's AI credits (Settings → Usage).")}</div>
    <//>`;
}

export { Toggle };
