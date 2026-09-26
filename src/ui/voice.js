import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { useApp, useUi } from './hooks.js';
import { Avatar, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { listen, speak, stopSpeaking, sttSupported } from './speech.js';
import { finalText } from '../core/runtime.js';
import { truncate } from '../core/util.js';
import { tr } from './i18n.js';

/** Hands-free conversation: listen → send → read the reply aloud → listen again. */
export function VoiceMode({ thread, agent, onClose }) {
  const app = useApp();
  const ui = useUi();
  const [phase, setPhase] = useState('idle'); // idle | listening | thinking | speaking
  const [said, setSaid] = useState('');
  const [reply, setReply] = useState('');
  const rec = useRef(null);
  const open = useRef(true);

  const startListening = () => {
    if (!open.current) return;
    if (!sttSupported()) {
      ui.toast(tr('Voice input is not supported in this browser (try Safari or Chrome).'), { error: true });
      setPhase('idle');
      return;
    }
    stopSpeaking();
    setSaid('');
    setPhase('listening');
    let latest = '';
    rec.current = listen({
      continuous: false,
      onText: (fin, interim) => {
        latest = (fin + interim).trim();
        setSaid(latest);
      },
      onEnd: (fin, stoppedByUser) => {
        const text = (fin || latest).trim();
        rec.current = null;
        if (!open.current) return;
        if (text) send(text);
        else if (!stoppedByUser) setPhase('idle');
      },
      onError: (err) => {
        ui.toast(err.message, { error: true });
        setPhase('idle');
      },
    });
  };

  const send = async (text) => {
    setPhase('thinking');
    setReply('');
    try {
      await app.runtime.send(thread.id, { text });
      const msgs = await app.loadMessages(thread.id);
      const last = [...msgs].reverse().find((m) => m.authorType === 'agent' && !m.hidden);
      const answer = last ? finalText(last) : '';
      if (!open.current) return;
      setReply(answer);
      // Stopped: nothing read aloud, and no listening until tapped.
      if (last?.status === 'stopped') {
        setPhase('idle');
        return;
      }
      if (last?.status === 'waiting') {
        setPhase('idle');
        await speak(tr('I need your input on screen.'));
        return;
      }
      if (answer) {
        setPhase('speaking');
        await speak(answer);
      }
      if (open.current) startListening();
    } catch (err) {
      ui.toast(err.message, { error: true });
      setPhase('idle');
    }
  };

  useEffect(() => {
    startListening();
    // The status bar takes the theme color: dark over voice mode, then back.
    const meta = document.querySelector('meta[name="theme-color"]');
    const before = meta?.getAttribute('content');
    meta?.setAttribute('content', '#050505');
    return () => {
      open.current = false;
      rec.current?.abort?.();
      stopSpeaking();
      if (before) meta?.setAttribute('content', before);
    };
  }, []);

  const mainAction = () => {
    if (phase === 'listening') rec.current?.stop();
    else if (phase === 'speaking') {
      stopSpeaking();
      startListening();
    } else if (phase === 'idle') startListening();
    else if (phase === 'thinking') Promise.resolve(app.runtime.stop(thread.id)).catch((err) => ui.toast(err.message, { error: true }));
  };

  const status = { idle: tr('Tap to talk'), listening: tr('Listening…'), thinking: tr('{name} is thinking…', { name: agent?.name || tr('Bot') }), speaking: tr('Speaking — tap to interrupt') }[phase];
  return html`
    <div class="voice" role="dialog" aria-label=${tr('Voice mode')}>
      <div class="top">
        <button class="circle-btn" aria-label=${tr('Close voice mode')} onClick=${onClose}><${Icon.x} /></button>
        <span class="status-pill"><span class="d" style="background:var(--green)"></span>${tr('Voice')}</span>
      </div>
      <div class="center">
        <${Avatar} shape=${agent?.shape} color=${agent?.color} size=${Math.min(200, innerWidth * 0.46)} live working=${phase === 'thinking'} anim=${thinkingOf(agent)}
          expression=${phase === 'listening' ? 'curious' : phase === 'speaking' ? 'happy' : undefined} />
        <div class="status">${status}</div>
        <div class="said">${said}</div>
        ${reply && phase !== 'listening' && html`<div class="reply">${truncate(reply, 600)}</div>`}
      </div>
      <div class="controls">
        <button class="end" aria-label=${tr('End')} onClick=${onClose}><${Icon.phoneOff} /></button>
        <button class=${`big ${phase === 'listening' ? 'listening' : ''}`} aria-label=${status} onClick=${mainAction}>
          ${phase === 'thinking' ? html`<${Icon.stop} />` : phase === 'speaking' ? html`<${Icon.wave} />` : html`<${Icon.mic} />`}
        </button>
      </div>
    </div>`;
}
