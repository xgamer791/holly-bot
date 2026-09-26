// What Holly Computer for Windows shows, in Windows' own language when Holly
// Bot speaks it (English, Spanish or Chinese), like the app's System choice.
// It's written in English, and each piece goes through tr('…'), which looks
// it up in the app's own dictionaries (src/ui/i18n/es.js and zh.js), so
// `node scripts/i18n.mjs` finds what's missing here too.

import es from '../../src/ui/i18n/es.js';
import zh from '../../src/ui/i18n/zh.js';
import { fill, resolveLanguage } from '../../src/core/i18n.js';

const DICTIONARIES = { es, zh };
let current = 'en';

/** Shows everything in the first of `preferred` (language tags, most wanted first) Holly Bot speaks. */
export function setLanguage(preferred = []) {
  current = resolveLanguage('system', preferred);
  return current;
}

/** 'en', 'es' or 'zh'. */
export function language() {
  return current;
}

/** `text` (English, with {names}) in the language in use, filled in from `vars`. */
export function tr(text, vars) {
  return fill(DICTIONARIES[current]?.[text] || text, vars);
}
