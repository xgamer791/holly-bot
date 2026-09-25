import { html } from '../../vendor/preact.js';

// Stroke icons (24×24, currentColor).

const I = (paths, { fill = 'none', sw = 2 } = {}) => (props = {}) => html`
  <svg viewBox="0 0 24 24" width=${props.size || 24} height=${props.size || 24} fill=${fill} stroke="currentColor"
    stroke-width=${props.sw || sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class=${props.class}>
    ${paths}
  </svg>`;

export const Icon = {
  back: I(html`<path d="M15 5l-7 7 7 7" />`, { sw: 2.4 }),
  chevron: I(html`<path d="M9 5l7 7-7 7" />`),
  down: I(html`<path d="M6 9l6 6 6-6" />`),
  expand: I(html`<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />`),
  collapse: I(html`<path d="M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M10 14l-6.5 6.5" />`),
  plus: I(html`<path d="M12 5v14M5 12h14" />`, { sw: 2.2 }),
  search: I(html`<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />`, { sw: 2.2 }),
  x: I(html`<path d="M6 6l12 12M18 6L6 18" />`, { sw: 2.4 }),
  monitor: I(html`<rect x="3" y="4" width="18" height="12" rx="2.5" /><path d="M9 20h6M12 16v4" />`, { sw: 2.2 }),
  mic: I(html`<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />`),
  // A screen with a face on a base: the bot's computer (the prompt bar).
  botScreen: I(html`<rect x="4" y="4" width="16" height="11.5" rx="2.5" /><path d="M10 8.2v3.1M14 8.2v3.1M3 19.5h18" />`, { sw: 2 }),
  server: I(html`<rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7.5 7.5h.01M7.5 16.5h.01" />`, { sw: 2.2 }),
  box: I(html`<path d="M21 7.5l-9-4.5-9 4.5 9 4.5 9-4.5zM3 7.5v9l9 4.5 9-4.5v-9M12 12v9" />`),
  lock: I(html`<rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8.5 11V7.5a3.5 3.5 0 017 0V11" />`),
  // GitHub's mark (Octicons, MIT).
  github: I(html`<path transform="translate(2 2) scale(1.25)" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />`, { fill: 'currentColor', sw: 0 }),
  wave: I(html`<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />`, { sw: 2.4 }),
  up: I(html`<path d="M12 19V6M6 11.5L12 5.5l6 6" />`, { sw: 2.6 }),
  image: I(html`<rect x="3" y="5" width="15" height="13" rx="2.5" /><path d="M6 21h13a2 2 0 002-2V8" /><circle cx="8" cy="9.5" r="1.4" /><path d="M3.5 16l4-4 3.5 3.5 2.5-2.5 4 4" />`),
  camera: I(html`<path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" /><circle cx="12" cy="13" r="3.6" /><path d="M18 5.5v2" />`),
  folder: I(html`<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z" />`),
  file: I(html`<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" />`),
  check: I(html`<path d="M5 12.5l4.5 4.5L19 7.5" />`, { sw: 2.6 }),
  brain: I(html`<path d="M9.5 4.5a3 3 0 00-5 2.3 3 3 0 00-1 5.2 3 3 0 002.6 4.5 3 3 0 005.4 1.5V6a3 3 0 00-2-1.5zM14.5 4.5a3 3 0 015 2.3 3 3 0 011 5.2 3 3 0 01-2.6 4.5 3 3 0 01-5.4 1.5" />`, { sw: 1.8 }),
  globe: I(html`<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />`, { sw: 1.8 }),
  code: I(html`<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />`),
  terminal: I(html`<rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M12.5 15H17" />`),
  chat: I(html`<path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.2A8 8 0 1120 12z" />`),
  users: I(html`<circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.6a3.5 3.5 0 010 6.8M18 14a6.5 6.5 0 013.5 6" />`),
  sparkle: I(html`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />`, { sw: 1.7 }),
  stop: I(html`<rect x="6" y="6" width="12" height="12" rx="2" />`, { fill: 'currentColor' }),
  copy: I(html`<rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />`),
  retry: I(html`<path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15M4 20v-5h5" />`),
  trash: I(html`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />`),
  pin: I(html`<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v7" />`),
  edit: I(html`<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />`),
  download: I(html`<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />`),
  upload: I(html`<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14" />`),
  clock: I(html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" />`),
  bell: I(html`<path d="M6 10a6 6 0 0112 0c0 5 2 6.5 2 6.5H4S6 15 6 10M10 20a2 2 0 004 0" />`),
  key: I(html`<circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16.5 6.5l2.5 2.5M14 9l2 2" />`),
  plug: I(html`<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4" />`),
  shield: I(html`<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />`),
  alert: I(html`<path d="M12 4l9.5 16h-19zM12 10v4.5M12 17.5v.5" />`),
  bot: I(html`<rect x="4" y="7" width="16" height="12" rx="4" /><path d="M12 3v4M9 12.5v1.5M15 12.5v1.5" />`),
  send: I(html`<path d="M4 12l16-8-6 16-2.5-6.5z" />`),
  link: I(html`<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />`),
  eye: I(html`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" />`),
  eyeOff: I(html`<path d="M3 3l18 18M10.6 5.6A9.5 9.5 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-3 3.8M6.3 6.4C3.9 8 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 004.4-1.1M9.9 9.9a3 3 0 004.2 4.2" />`),
  phoneOff: I(html`<path d="M4.5 13.5c4.5-4 10.5-4 15 0l-1.5 3-3-1v-2.5a9 9 0 00-6 0v2.5l-3 1z" />`, { fill: 'currentColor', sw: 1 }),
  play: I(html`<path d="M7 5l12 7-12 7z" />`, { fill: 'currentColor' }),
  refresh: I(html`<path d="M20 12a8 8 0 11-2.3-5.7L20 8.5M20 4v4.5h-4.5" />`),
  gear: I(html`<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />`, { sw: 1.6 }),
  palette: I(html`<path d="M12 3a9 9 0 100 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.4-4-7.9-9-7.9z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="14.5" cy="7" r="1" />`, { sw: 1.7 }),
  dots: I(html`<circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />`, { fill: 'currentColor', sw: 0 }),
  calendar: I(html`<rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" />`),
  mail: I(html`<rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M4 7.5l8 6 8-6" />`),
  cpu: I(html`<rect x="6" y="6" width="12" height="12" rx="2.5" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />`),
  memory: I(html`<rect x="3" y="6" width="18" height="10" rx="2" /><path d="M7.5 9.5v3M12 9.5v3M16.5 9.5v3M6 16v3M10 16v3M14 16v3M18 16v3" />`),
  // A phone buzzing: haptics.
  haptics: I(html`<rect x="8" y="3.5" width="8" height="17" rx="2.2" /><path d="M4.5 9v6M19.5 9v6" />`),
  help: I(html`<circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 014.9.7c0 1.7-2.5 2.1-2.5 3.8M12 17h.01" />`),
  archive: I(html`<rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 002 2h10a2 2 0 002-2V9M10 13h4" />`),
  logout: I(html`<path d="M10 4H6.5A2.5 2.5 0 004 6.5v11A2.5 2.5 0 006.5 20H10M15 16l4-4-4-4M19 12H9" />`),
  // Opens somewhere else (a new tab).
  external: I(html`<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />`),
};

export function fileIcon(mime = '', path = '') {
  if (mime.startsWith('image/')) return Icon.image;
  if (/\.(js|ts|py|json|html|css|sh|go|rs|java|rb|c|cpp)$/i.test(path)) return Icon.code;
  return Icon.file;
}
