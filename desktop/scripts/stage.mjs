// Gets Holly Computer for Windows ready to run (npm start) or to package
// (electron-builder, which takes app\ and stage\: package.json "build"):
//
//   app\main.cjs              the app (src\), in one file, with the app's dictionaries
//   app\preload.cjs, status\, icons\
//   stage\computer\           holly-computer.mjs, as the Holly Bot site serves it (build it first:
//                             npm run build:computer in the project)
//   stage\node\               Node.js for Windows (x64), the version in package.json "config",
//                             from nodejs.org, checked against its published SHA-256
//
//   node scripts/stage.mjs            everything
//   node scripts/stage.mjs --no-node  everything but Node.js (it's kept from before)
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = join(desktop, '..');
const app = join(desktop, 'app');
const stage = join(desktop, 'stage');
const cache = join(desktop, '.cache');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

// ----- the app ---------------------------------------------------------------------------

rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'status'), { recursive: true });
await build({
  entryPoints: [join(desktop, 'src', 'main.js')],
  outfile: join(app, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater'],
  legalComments: 'eof',
  logLevel: 'warning',
});
await build({
  entryPoints: [join(desktop, 'src', 'status', 'status.js')],
  outfile: join(app, 'status', 'status.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  legalComments: 'eof',
  logLevel: 'warning',
});
cpSync(join(desktop, 'src', 'preload.cjs'), join(app, 'preload.cjs'));
for (const file of ['index.html', 'status.css']) cpSync(join(desktop, 'src', 'status', file), join(app, 'status', file));
cpSync(join(desktop, 'src', 'icons'), join(app, 'icons'), { recursive: true });
console.log('app: main.cjs, preload.cjs, status/, icons/');

// ----- Holly Computer ------------------------------------------------------------------------

const script = join(root, 'computer', 'holly-computer.mjs');
if (!existsSync(script)) throw new Error('computer/holly-computer.mjs is missing: run npm run build:computer in the project first.');
mkdirSync(join(stage, 'computer'), { recursive: true });
cpSync(script, join(stage, 'computer', 'holly-computer.mjs'));
const built = /\(app (\d+\.\d+\.\d+)\)/.exec(readFileSync(script, 'utf8').slice(0, 2000))?.[1];
console.log(`stage/computer: holly-computer.mjs ${built}`);

// ----- Node.js --------------------------------------------------------------------------------

const version = pkg.config.node;
const name = `node-v${version}-win-x64`;
const nodeDir = join(stage, 'node');
if (process.argv.includes('--no-node') && existsSync(join(nodeDir, 'node.exe'))) {
  console.log('stage/node: kept');
} else {
  const zip = join(cache, `${name}.zip`);
  const sums = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
  const want = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, file]) => file === `${name}.zip`)?.[0];
  if (!want) throw new Error(`nodejs.org lists no ${name}.zip`);
  let data = existsSync(zip) ? readFileSync(zip) : null;
  if (!data || sha256(data) !== want) {
    mkdirSync(cache, { recursive: true });
    const res = await fetch(`https://nodejs.org/dist/v${version}/${name}.zip`);
    if (!res.ok) throw new Error(`Downloading ${name}.zip failed (${res.status})`);
    data = Buffer.from(await res.arrayBuffer());
    if (sha256(data) !== want) throw new Error(`${name}.zip doesn't match its SHA-256 on nodejs.org`);
    writeFileSync(zip, data);
  }
  const unpacked = join(stage, 'node-unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  rmSync(nodeDir, { recursive: true, force: true });
  unzip(data, unpacked);
  renameSync(join(unpacked, name), nodeDir);
  rmSync(unpacked, { recursive: true, force: true });
  if (!existsSync(join(nodeDir, 'node.exe'))) throw new Error(`${name}.zip has no node.exe`);
  console.log(`stage/node: Node.js ${version} (${readdirSync(nodeDir).length} entries)`);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Unpacks a zip (stored and deflated files, as Node.js's own is) into `dir`,
 * refusing any path that would land outside it. */
function unzip(zip, dir) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip file is damaged');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const path = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (/^[\\/]|^[a-z]:/i.test(path) || parts.includes('..')) throw new Error(`the zip file has a path outside it: ${path}`);
    const out = join(dir, ...parts);
    if (path.endsWith('/')) {
      mkdirSync(out, { recursive: true });
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`the zip file packs ${path} in a way this can't unpack (${method})`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, method === 8 ? inflateRawSync(body) : body);
  }
}
