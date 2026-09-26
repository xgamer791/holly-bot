// Renders Holly Bot Computer for Windows' icons from Holly Bot's own art, with
// Playwright's Chromium (from the project's dev dependencies):
//   build/icon.png                 the app's icon (electron-builder makes the .ico from it)
//   src/icons/icon.png             the window's and notifications' icon
//   src/icons/tray*.png            the icon in the taskbar's corner, for each display scale
// The app's icon is the one Holly Bot has on phones (icons/icon.svg); the
// tray's is the blue cloud from the app's loading screen (index.html), which
// shows on light and dark taskbars alike.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = join(desktop, '..');

const appIcon = readFileSync(join(root, 'icons', 'icon.svg'), 'utf8');
const cloud = /<svg viewBox="0 0 100 100"[^>]*>([\s\S]*?)<\/svg>/.exec(readFileSync(join(root, 'index.html'), 'utf8'))[1];
const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${cloud}</svg>`;

const renders = [
  [appIcon, 512, 'build/icon.png'],
  [appIcon, 256, 'src/icons/icon.png'],
  [trayIcon, 16, 'src/icons/tray.png'],
  [trayIcon, 20, 'src/icons/tray@1.25x.png'],
  [trayIcon, 24, 'src/icons/tray@1.5x.png'],
  [trayIcon, 32, 'src/icons/tray@2x.png'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, size, file] of renders) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const out = join(desktop, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await page.screenshot({ type: 'png', omitBackground: true }));
  console.log(file);
}
await browser.close();
