// Builds Holly Computer into one file you can run with Node.js 22+:
//
//   computer/holly-computer.mjs
//
// It holds the companion, the app core the bots run on, and the whole web app
// (served to your phone), so there is nothing else to install. The code is left
// unminified so anyone can read what they are running.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'computer', 'holly-computer.mjs');
const TEXT = /\.(html|css|js|mjs|json|webmanifest|svg|txt|md)$/;

function collect(dir, list = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, list);
    else list.push(p);
  }
  return list;
}

const files = [
  ...['index.html', 'privacy.html', 'terms.html', 'styles.css', 'manifest.webmanifest', 'sw.js'].map((f) => join(root, f)),
  ...collect(join(root, 'icons')),
  ...collect(join(root, 'vendor')),
  ...collect(join(root, 'src')),
];
const assets = {};
for (const file of files) {
  const path = relative(root, file).split(sep).join('/');
  const buf = readFileSync(file);
  assets[path] = TEXT.test(path) ? buf.toString('utf8') : `base64:${buf.toString('base64')}`;
}

const result = await build({
  entryPoints: [join(root, 'computer', 'src', 'main.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  legalComments: 'eof',
  logLevel: 'warning',
});
const code = result.outputFiles[0].text.replace(/^#!.*\n/, '');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const header = `#!/usr/bin/env node
// Holly Computer — your Holly bots live on this computer; control them from your phone.
// Run:  node holly-computer.mjs      (needs Node.js 22 or newer: https://nodejs.org)
// Help: node holly-computer.mjs --help
// Built from https://github.com/xgamer791/holly-bot (app ${version}). Generated file — edit computer/src and src instead.
globalThis.__HOLLY_BUNDLE__ = true;
globalThis.__HOLLY_ASSETS__ = ${JSON.stringify(assets)};
`;
writeFileSync(out, header + code);
const size = statSync(out).size;
console.log(`Wrote ${relative(root, out)} (${(size / 1024 / 1024).toFixed(2)} MB, ${Object.keys(assets).length} web files embedded)`);
