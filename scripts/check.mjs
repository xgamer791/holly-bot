// Quick checks before committing: every JS file parses, and the single-file
// Holly Computer build is up to date with its sources.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(name) && name !== 'holly-computer.mjs') files.push(p);
  }
};
for (const d of ['src', 'computer/src', 'scripts', 'tests']) walk(join(root, d));
files.push(join(root, 'sw.js'));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad++;
    console.error(String(err.stderr || err.message));
  }
}
console.log(`${files.length - bad}/${files.length} files parse`);

const bundle = join(root, 'computer', 'holly-computer.mjs');
const before = readFileSync(bundle, 'utf8');
execFileSync(process.execPath, [join(root, 'scripts', 'build-computer.mjs')], { stdio: 'pipe' });
const fresh = readFileSync(bundle, 'utf8') === before;
console.log(fresh ? 'computer/holly-computer.mjs is up to date' : 'computer/holly-computer.mjs was out of date — rebuilt it; commit the new file');
process.exit(bad || !fresh ? 1 : 0);
