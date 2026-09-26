// The languages Holly Bot speaks. The app is written in English, and what a
// person sees goes through a translation (src/ui/i18n.js, dictionaries in
// src/ui/i18n/) that looks the English up. This is the part the app core
// needs too, wherever the bots run (in the app or on Holly Bot Computer): the
// languages, filling in {names}, phrases the app translates as it shows them
// (what a bot is doing, on its cards), and the few things a new bot says
// before anyone has written to it, in the language the app was last shown in
// (settings.uiLanguage, kept by src/main.js).

/** In the order Settings → Language lists them. `english`: its name in
 * English, for the bots. */
export const LANGUAGES = [
  { code: 'en', name: 'English', english: mark('English') },
  { code: 'es', name: 'Español', english: mark('Spanish') },
  { code: 'zh', name: '中文', english: mark('Chinese (Simplified)') },
];

const CODES = LANGUAGES.map((l) => l.code);

/** The language a choice in Settings → Language comes to: one of LANGUAGES,
 * or for 'system' the first of the device's own languages Holly Bot speaks
 * (English when it speaks none of them). */
export function resolveLanguage(choice, preferred = deviceLanguages()) {
  if (CODES.includes(choice)) return choice;
  for (const tag of preferred) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    if (CODES.includes(base)) return base;
  }
  return 'en';
}

function deviceLanguages() {
  try {
    const nav = globalThis.navigator;
    return [...(nav?.languages?.length ? nav.languages : [nav?.language])].filter(Boolean);
  } catch {
    return [];
  }
}

/** A language's name in English ('Spanish'), for telling the bots. */
export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.english || 'English';
}

/** `text` with each {name} in it replaced by vars.name (left as it is when
 * vars has no such name). A value that's a phrase (or a list of lines) is
 * filled in the same way. */
export function fill(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => {
    const value = vars[name];
    if (value == null) return whole;
    return isPhrase(value) || Array.isArray(value) ? spoken(value).text : String(value);
  });
}

/** Whether `value` is a phrase (below). */
export function isPhrase(value) {
  return !!value && typeof value === 'object' && typeof value.text === 'string';
}

/** English for the app to show in the person's language: it looks `text` up
 * and fills in `vars` as it shows it (src/ui/i18n.js trp). Tool labels,
 * approvals, activity and chat previews are made of these, kept beside their
 * English as `say` (spoken). A var can be a phrase too, and several lines
 * can be a list of phrases and plain text. */
export function phrase(text, vars) {
  return vars ? { text, vars } : { text };
}

/** A label, approval or preview as it's kept: `text`, the English, and
 * `say`, what to show translated (null for plain text). `value`: a phrase,
 * plain text, or a list of them, one per line. */
export function spoken(value, fallback = '') {
  if (Array.isArray(value)) {
    const text = value.map((line) => spoken(line).text).join('\n');
    return { text, say: value.some(isPhrase) ? value : null };
  }
  if (isPhrase(value)) return { text: fill(value.text, value.vars), say: value };
  return { text: value == null ? fallback : String(value), say: null };
}

/** Marks English the app shows as it is elsewhere (lists of labels, shown
 * with tr()): the dictionaries pick it up from here, and it comes back as it
 * is. */
export function mark(text) {
  return text;
}

/**
 * What a new bot says before anyone has written to it (src/core/app.js greet,
 * src/core/chief.js), and the choices on its first card, in each language.
 * Everything else a bot writes, it writes in the language it's told
 * (src/core/prompts.js).
 */
const FIRST_WORDS = {
  es: {
    "Hey — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?": 'Hola, soy {name}. Cuando quieras, empezamos.\n\n¿En qué quieres que te ayude más?',
    "Hey {user} — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?": 'Hola, {user}. Soy {name}. Cuando quieras, empezamos.\n\n¿En qué quieres que te ayude más?',
    'What should I focus on first?': '¿En qué me enfoco primero?',
    "Pick whatever's most useful — we can expand from there.": 'Elige lo que te sea más útil; a partir de ahí podemos ampliar.',
    'Something else': 'Otra cosa',
    'Coding & projects': 'Código y proyectos',
    'Email & calendar': 'Correo y calendario',
    'Research & writing': 'Investigación y redacción',
    'Shopping & errands': 'Compras y recados',
    'Sales & outreach': 'Ventas y prospección',
    'What should your team take on first?': '¿Qué debería abordar tu equipo primero?',
    "Pick one and I'll suggest the bots for it.": 'Elige una y te sugeriré los bots para ello.',
    "Hi, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?":
      'Hola, soy {name}, tu jefe de gabinete. Tú hablas conmigo y yo dirijo tu equipo de bots: le paso cada tarea al bot indicado, te sugiero bots nuevos cuando los necesites y te consulto las decisiones.\n\nCuéntame un poco sobre ti y tu trabajo. ¿Por dónde empezamos?',
    "Hi {user}, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?":
      'Hola, {user}. Soy {name}, tu jefe de gabinete. Tú hablas conmigo y yo dirijo tu equipo de bots: le paso cada tarea al bot indicado, te sugiero bots nuevos cuando los necesites y te consulto las decisiones.\n\nCuéntame un poco sobre ti y tu trabajo. ¿Por dónde empezamos?',
  },
  zh: {
    "Hey — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?": '你好，我是{name}。随时准备为你效劳。\n\n你最希望我帮你做什么？',
    "Hey {user} — I'm {name}. Ready whenever you are.\n\nWhat do you want me helping with most?": '你好，{user}，我是{name}。随时准备为你效劳。\n\n你最希望我帮你做什么？',
    'What should I focus on first?': '我应该先专注于什么？',
    "Pick whatever's most useful — we can expand from there.": '选一个最有用的，之后我们可以再扩展。',
    'Something else': '其他',
    'Coding & projects': '编程与项目',
    'Email & calendar': '邮件与日历',
    'Research & writing': '研究与写作',
    'Shopping & errands': '购物与杂事',
    'Sales & outreach': '销售与拓展',
    'What should your team take on first?': '你的团队应该先做什么？',
    "Pick one and I'll suggest the bots for it.": '选一个，我会为它推荐合适的机器人。',
    "Hi, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?":
      '你好，我是{name}，你的幕僚长。你只需要和我对话，我来管理你的机器人团队：把每项工作交给合适的机器人，在你需要时推荐新的机器人，并在需要决定时回来问你。\n\n先跟我说说你自己和你的工作吧。我们从哪里开始？',
    "Hi {user}, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?":
      '你好，{user}，我是{name}，你的幕僚长。你只需要和我对话，我来管理你的机器人团队：把每项工作交给合适的机器人，在你需要时推荐新的机器人，并在需要决定时回来问你。\n\n先跟我说说你自己和你的工作吧。我们从哪里开始？',
  },
};

/** One of a new bot's first words (FIRST_WORDS) in `lang`, with {names} filled in. */
export function firstWords(lang, text, vars) {
  return fill(FIRST_WORDS[lang]?.[text] || text, vars);
}
