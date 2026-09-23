// Constants shared by core logic and UI (kept free of UI imports so core runs in Node tests).

export const APP_NAME = 'Holly Bot';
export const APP_VERSION = '1.0.0';

export const SHAPE_KEYS_CORE = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop'];
export const COLOR_KEYS_CORE = ['white', 'brown', 'red', 'vermilion', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/** Tool groups a bot can switch on/off in its settings. */
export const TOOL_GROUPS = {
  web: { label: 'Web search & browsing', description: 'Search the web and read pages', default: true },
  code: { label: 'Code sandbox', description: 'Run Python and JavaScript in your browser', default: true },
  files: { label: 'Files', description: 'Its own drive to create, read and send files', default: true },
  memory: { label: 'Memory tools', description: 'Save, recall, update and forget memories', default: true },
  agents: { label: 'Talk to other bots', description: 'Message bots, delegate tasks, create bots', default: true },
  routines: { label: 'Routines', description: 'Schedule recurring or one-time tasks', default: true },
  images: { label: 'Image generation', description: 'Create images with your provider', default: true },
  computer: { label: 'Bot Computer', description: 'Shell, files and browser on your connected computer', default: true },
  plugins: { label: 'Plugins (MCP)', description: 'Tools from your connected MCP servers', default: true },
};

export const FOCUS_OPTIONS = ['Coding & projects', 'Email & calendar', 'Research & writing', 'Shopping & errands', 'Something else'];

export const MAX_TOOL_STEPS = 24;
