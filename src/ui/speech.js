// Speech: dictation (Web Speech recognition) and read-aloud (speech synthesis).

export function sttSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Start speech recognition. Returns { stop }.
 * onText(finalText, interimText) is called as results arrive.
 */
export function listen({ onText, onEnd, onError, continuous = true, lang } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError?.(new Error('Speech recognition is not supported in this browser.'));
    return { stop() {} };
  }
  const rec = new SR();
  rec.continuous = continuous;
  rec.interimResults = true;
  rec.lang = lang || navigator.language || 'en-US';
  let finalText = '';
  let stopped = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText?.(finalText, interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError?.(new Error(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Speech recognition error: ${e.error}`));
  };
  rec.onend = () => onEnd?.(finalText, stopped);
  try {
    rec.start();
  } catch (err) {
    onError?.(err);
  }
  return {
    stop() {
      stopped = true;
      try {
        rec.stop();
      } catch { /* already stopped */ }
    },
    abort() {
      stopped = true;
      try {
        rec.abort();
      } catch { /* already stopped */ }
    },
  };
}

export function plainForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .trim();
}

export function voices() {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Speak text with the browser voice. Resolves when done. */
export function speak(text, app, { rate } = {}) {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    stopSpeaking();
    const clean = plainForSpeech(text);
    if (!clean) return resolve();
    // Split into sentences so long replies don't get cut off by some engines.
    const chunks = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
    const pref = app?.settings?.voice?.name;
    const voice = voices().find((v) => v.name === pref) || voices().find((v) => /en[-_]US/i.test(v.lang) && /Samantha|Google US|Natural|Premium|Enhanced/i.test(v.name)) || null;
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return resolve();
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (voice) u.voice = voice;
      u.rate = rate || app?.settings?.voice?.rate || 1.05;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}
