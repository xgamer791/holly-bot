import { html } from '../../vendor/preact.js';
import { LANGUAGES, resolveLanguage, fill, isPhrase, mark } from '../core/i18n.js';

export { LANGUAGES, mark };

// What the app shows, in the person's language. The app is written in
// English, and each piece of text it shows goes through tr() (or trx(), trn(),
// trp()), which looks the English up in the dictionary for the language in use
// (src/ui/i18n/<code>.js: English → translation) and falls back to the
// English. {names} in the text are filled in after the lookup, so the English
// with its {names} is the key: tr('Delete {name}?', { name }).
//
// The language is Settings → Language (settings.language, kept in the
// account): English, Spanish or Chinese, or 'system', the device's own when
// Holli Bot speaks it. Before the account opens (welcome, sign-in, the plan
// page waiting for Stripe) the app goes by the choice this device last used.
//
// New or changed text: write the English inside tr(), then add it to every
// dictionary. `node scripts/i18n.mjs` lists what's missing or out of date.

const DEVICE_CHOICE = 'holly.language';
const DICTIONARIES = {
  es: () => import('./i18n/es.js'),
  zh: () => import('./i18n/zh.js'),
};

let current = 'en';
let dict = null;

/** The language the app shows: 'en', 'es' or 'zh'. */
export function language() {
  return current;
}

/** The choice (a language, or 'system') this device last used. */
export function deviceChoice() {
  try {
    return localStorage.getItem(DEVICE_CHOICE) || 'system';
  } catch {
    return 'system';
  }
}

/**
 * Shows the app in `choice` (a language, or 'system') from the next render
 * on, once its dictionary has loaded, and remembers the choice on this
 * device. Resolves to the language it came to (the one it was in, if the
 * dictionary couldn't be loaded).
 */
export async function setLanguage(choice = 'system') {
  try {
    localStorage.setItem(DEVICE_CHOICE, choice || 'system');
  } catch { /* storage blocked: the next launch starts from the device's language */ }
  const code = resolveLanguage(choice);
  if (code === current && (code === 'en' || dict)) return current;
  let next = null;
  if (DICTIONARIES[code]) {
    try {
      next = (await DICTIONARIES[code]()).default;
    } catch (err) {
      console.warn('language', err);
      return current;
    }
  }
  current = code;
  dict = next;
  try {
    document.documentElement.lang = locale();
  } catch { /* no document */ }
  return current;
}

/** `text` (English, with {names}) in the app's language, filled in from `vars`. */
export function tr(text, vars) {
  return fill((dict && dict[text]) || text, vars);
}

/** tr() for a count: `one` when `n` is 1, `other` otherwise (both English,
 * with {n}, which is filled in as a number in the app's language). */
export function trn(n, one, other, vars) {
  return tr(n === 1 ? one : other, { ...vars, n: number(n) });
}

/**
 * tr() for text with more than words in it, as children in html`` (not in an
 * attribute): each {name} becomes parts.name (a link, a button, a <b>…</b>),
 * and **words** between double asterisks come out bold.
 */
export function trx(text, parts = {}) {
  const out = [];
  for (const chunk of ((dict && dict[text]) || text).split(/(\*\*[^*]+\*\*)/)) {
    if (!chunk) continue;
    const bold = /^\*\*[^*]+\*\*$/.test(chunk);
    const pieces = (bold ? chunk.slice(2, -2) : chunk).split(/(\{\w+\})/).filter(Boolean).map((piece) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      return name && name in parts ? parts[name] : piece;
    });
    out.push(bold ? html`<b>${pieces}</b>` : pieces);
  }
  return out;
}

/** A phrase from the app core (src/core/i18n.js phrase), plain English, or
 * a list of them (one per line), in the app's language. Values that are
 * phrases themselves are translated too. */
export function trp(p) {
  if (Array.isArray(p)) return p.map(trp).join('\n');
  if (!p) return '';
  if (!isPhrase(p)) return tr(String(p));
  if (!p.vars) return tr(p.text);
  const vars = {};
  for (const [name, value] of Object.entries(p.vars)) vars[name] = isPhrase(value) || Array.isArray(value) ? trp(value) : value;
  return tr(p.text, vars);
}

/** What the app core kept beside a label, preview or approval: its phrase
 * (`say`) in the app's language, or else its plain text as it is (a bot's
 * words, a command), which isn't looked up. */
export function phraseOr(say, text) {
  return say ? trp(say) : text ?? '';
}

/** The locale dates and numbers are written in: the device's own when it's
 * in the app's language (en-GB stays en-GB), else the language's. */
export function locale() {
  try {
    for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const [base, ...rest] = String(tag || '').split(/[-_]/);
      if (base.toLowerCase() !== current) continue;
      // The app's Chinese is Simplified.
      if (current === 'zh' && /^(tw|hk|mo|hant)$/i.test(rest[0] || '')) continue;
      return tag;
    }
  } catch { /* no navigator */ }
  return current === 'zh' ? 'zh-CN' : current;
}

/** A number written the app's way (1,000 or 1.000). */
export function number(n) {
  return Number(n).toLocaleString(locale());
}

/** A date, in the app's language: `opts` as for toLocaleDateString. */
export function dateText(ts, opts) {
  return new Date(ts).toLocaleDateString(locale(), opts);
}

/** A date and time, in the app's language: `opts` as for toLocaleString. */
export function dateTimeText(ts, opts) {
  return new Date(ts).toLocaleString(locale(), opts);
}

/** "2:06 PM", or "14:06" where that's how the time is written. */
export function clock(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Compact, for lists: "now", "5m", "2:06 PM", "Mon", "Sep 3". */
export function shortTime(ts, ref = Date.now()) {
  const s = Math.round((ref - ts) / 1000);
  if (s < 60) return tr('now');
  if (s < 3600) return tr('{n}m', { n: Math.floor(s / 60) });
  if (startOfDay(ts) === startOfDay(ref)) return clock(ts);
  if (ref - ts < 7 * DAY) return dateText(ts, { weekday: 'short' });
  return dateText(ts, { month: 'short', day: 'numeric' });
}

/** "Today 2:06 PM", "Yesterday 9:10 AM", "Mon 4:00 PM", "Sep 3, 4:00 PM". */
export function dayTime(ts, ref = Date.now()) {
  const days = Math.round((startOfDay(ref) - startOfDay(ts)) / DAY);
  const time = clock(ts);
  if (days <= 0) return tr('Today {time}', { time });
  if (days === 1) return tr('Yesterday {time}', { time });
  if (days < 7) return tr('{day} {time}', { day: dateText(ts, { weekday: 'short' }), time });
  return tr('{date}, {time}', { date: dateText(ts, { month: 'short', day: 'numeric' }), time });
}

/** When a chat was last active, for the chat list: "2:06 PM" today, then
 * "Yesterday", the day of the week within a week ("Wednesday"), and the date
 * ("Sep 3", or "Sep 3, 2025" in another year). */
export function dayOrTime(ts, ref = Date.now()) {
  const days = Math.round((startOfDay(ref) - startOfDay(ts)) / DAY);
  if (days <= 0) return clock(ts);
  if (days === 1) return tr('Yesterday');
  const otherYear = new Date(ts).getFullYear() !== new Date(ref).getFullYear();
  const text = days < 7 ? dateText(ts, { weekday: 'long' }) : dateText(ts, { month: 'short', day: 'numeric', ...(otherYear && { year: 'numeric' }) });
  // Spanish writes the days in lowercase ("miércoles"); first in a label, they take a capital.
  return text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1);
}

/** "Apple and Google", in the app's language. */
export function listText(items) {
  try {
    return new Intl.ListFormat(locale(), { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** A day of the week (0 is Sunday), short: "Mon". */
function weekday(day) {
  return dateText(new Date(2024, 0, 7 + day), { weekday: 'short' }); // 7 January 2024 was a Sunday
}

/** A routine's schedule (src/core/routines.js), in words: "Every day at
 * 8:30 AM", "Weekdays at 9:00 AM", "Every 2 hours". */
export function scheduleText(s) {
  if (!s) return '';
  const at = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return clock(new Date(2000, 0, 1, h, m).getTime());
  };
  switch (s.kind) {
    case 'once': return tr('Once on {date}', { date: dateTimeText(s.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
    case 'interval':
      if (s.everyMinutes % 60) return tr('Every {n} min', { n: number(s.everyMinutes) });
      return s.everyMinutes === 60 ? tr('Every hour') : tr('Every {n} hours', { n: number(s.everyMinutes / 60) });
    case 'daily': return tr('Every day at {time}', { time: at(s.time) });
    case 'weekly': {
      const weekdays = s.days.length === 5 && !s.days.includes(0) && !s.days.includes(6);
      return weekdays ? tr('Weekdays at {time}', { time: at(s.time) }) : tr('{days} at {time}', { days: listText(s.days.map(weekday)), time: at(s.time) });
    }
    default: return '';
  }
}
