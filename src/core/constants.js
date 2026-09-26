// Constants shared by core logic and UI (kept free of UI imports so core runs in Node tests).

import { mark } from './i18n.js';

export const APP_NAME = 'Holly Bot';
export const APP_VERSION = '1.38.3';

export const SHAPE_KEYS_CORE = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop'];
export const COLOR_KEYS_CORE = ['white', 'brown', 'red', 'vermilion', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
/** Each bot's own little animation while it thinks or works. */
export const THINKING_KEYS = ['ponder', 'hop', 'jelly', 'orbit', 'scan', 'sparkle', 'float', 'nod', 'twirl'];

/** Tool groups a bot can switch on/off in its settings (their words are
 * shown translated: src/core/i18n.js mark). */
export const TOOL_GROUPS = {
  web: { label: mark('Web search & browsing'), description: mark('Search the web and read pages'), default: true },
  code: { label: mark('Code sandbox'), description: mark('Run Python and JavaScript in your browser'), default: true },
  files: { label: mark('Files'), description: mark('Its own drive to create, read and send files'), default: true },
  memory: { label: mark('Memory tools'), description: mark('Save, recall, update and forget memories'), default: true },
  agents: { label: mark('Talk to other bots'), description: mark('Message bots, delegate tasks, create bots'), default: true },
  routines: { label: mark('Routines'), description: mark('Schedule recurring or one-time tasks'), default: true },
  images: { label: mark('Image generation'), description: mark('Create images with your provider'), default: true },
  computer: { label: mark('Bot Computer'), description: mark('Shell, files and browser on your connected computer'), default: true },
  email: { label: mark('Email'), description: mark('Read, send and delete email in your Gmail or Outlook'), default: true },
  github: { label: mark('GitHub'), description: mark('Create, edit and delete your repositories'), default: true },
  plugins: { label: mark('Plugins (MCP)'), description: mark('Tools from your connected MCP servers'), default: true },
};

export const FOCUS_OPTIONS = ['Coding & projects', 'Email & calendar', 'Research & writing', 'Shopping & errands', 'Something else'];

export const MAX_TOOL_STEPS = 24;

/** How hard a bot thinks when neither it nor the app's defaults say: as hard
 * as it can (DeepSeek's max; a bot's profile can set it lower, for faster,
 * cheaper replies). */
export const DEFAULT_EFFORT = 'max';

/** How hard `agent` thinks: its own setting, else the app's, else DEFAULT_EFFORT. */
export function effortOf(app, agent) {
  return agent?.effort || app.settings.defaults?.effort || DEFAULT_EFFORT;
}
