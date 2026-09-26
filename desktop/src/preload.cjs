// The window's way to this app (main.js): what it shows, and what it asks for.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holly', {
  /** Everything the window shows, and what Holly Computer has printed so far. */
  get: () => ipcRenderer.invoke('holly:get'),
  /** Asks for something: open, start, restart, folder, pick, set, apply, newKeys, update, copy, quit. */
  act: (action, arg) => ipcRenderer.invoke('holly:act', action, arg),
  /** What the window shows, each time it changes. */
  onView: (fn) => ipcRenderer.on('holly:view', (_event, view) => fn(view)),
  /** New lines Holly Computer printed. */
  onLines: (fn) => ipcRenderer.on('holly:lines', (_event, lines) => fn(lines)),
});
