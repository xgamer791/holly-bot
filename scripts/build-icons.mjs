// Renders the app icons (PNG) from the SVG avatar art using Playwright's Chromium.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = readFileSync(join(root, 'src/ui/avatar.js'), 'utf8')
  .replace(/^import .*preact.*$/m, 'const html=()=>null,useEffect=()=>{},useRef=()=>({}),useState=(v)=>[v,()=>{}];');
const tmp = join(root, '.vendor-tmp');
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, 'avatar-node.mjs'), src);
const { avatarSvgString } = await import(join(tmp, 'avatar-node.mjs'));

const inner = avatarSvgString({ shape: 'cloud', color: 'white', expression: 'downLeft' })
  .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const icon = (pad, radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="${radius}" fill="#0b0b0b"/>
<g transform="translate(${pad} ${pad}) scale(${(100 - 2 * pad) / 100})">${inner}</g></svg>`;

mkdirSync(join(root, 'icons'), { recursive: true });
writeFileSync(join(root, 'icons/icon.svg'), icon(16, 22));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad, radius] of [
  ['icon-192.png', 192, 16, 0], ['icon-512.png', 512, 16, 0], ['icon-maskable-512.png', 512, 24, 0], ['apple-touch-icon.png', 180, 16, 0],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0b0b0b">${icon(pad, radius).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(join(root, 'icons', name), await page.screenshot({ type: 'png' }));
  console.log('icons/' + name);
}
await browser.close();
