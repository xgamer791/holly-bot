// The app's words and their translations (src/ui/i18n.js). Finds all the
// English the app shows: tr('…'), trx('…'), trn(n, '…', '…'), phrase('…') and
// mark('…') in src/ and in desktop/src/ (Holly Bot Computer for Windows, which
// uses the same dictionaries), and the server's own words, new
// ConvexError("…") in convex/, which the app translates as it shows them.
// Then it checks each dictionary in src/ui/i18n/ against them: what's missing,
// what nothing uses any more, and translations whose {names} or **bold**
// don't match the English.
//
//   node scripts/i18n.mjs                    the report (exits 1 if anything is missing or wrong)
//   node scripts/i18n.mjs --keys             the English, as a JSON array, in the order it's found
//   node scripts/i18n.mjs --missing es       what es lacks, as [{ text, file }] (where it's first used)
//   node scripts/i18n.mjs --write es t.json  adds the translations in t.json (English → Spanish)
//                                            to src/ui/i18n/es.js, dropping what nothing uses
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const DICTIONARIES = join(root, 'src', 'ui', 'i18n');
const LANGS = { es: 'Español: the app in Spanish', zh: '中文: the app in Chinese (Simplified)' };
/** Calls whose first argument is English the app shows (trn: its second and third). */
const MARKERS = new Set(['tr', 'trx', 'phrase', 'mark']);

function listFiles(dir, test, list = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p !== DICTIONARIES && name !== '_generated' && name !== 'node_modules') listFiles(p, test, list);
    } else if (test(name)) list.push(p);
  }
  return list;
}

const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

/** The English in `file`, and calls that can't be looked up (a template with ${…} in it). */
function scan(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found = [];
  const problems = [];
  const where = (node) => `${relative(root, file).split(sep).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const take = (node, arg) => {
    if (!arg) return;
    const s = literal(arg);
    if (s != null) found.push(s);
    else if (ts.isTemplateExpression(arg)) problems.push(`${where(node)}: English with \${…} in it can't be looked up: write {names} and pass them`);
  };
  const visit = (node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const args = node.arguments || [];
      if (file.endsWith('.ts')) {
        if (name === 'ConvexError' && literal(args[0]) != null) found.push(literal(args[0]));
      } else if (MARKERS.has(name)) take(node, args[0]);
      else if (name === 'trn') {
        take(node, args[1]);
        take(node, args[2]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { found, problems };
}

function english() {
  const keys = [];
  const files = {};
  const seen = new Set();
  const problems = [];
  const sources = [
    ...listFiles(join(root, 'src'), (n) => n.endsWith('.js')),
    ...listFiles(join(root, 'desktop', 'src'), (n) => n.endsWith('.js')),
    ...listFiles(join(root, 'convex'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts')),
  ];
  for (const file of sources) {
    const { found, problems: p } = scan(file);
    problems.push(...p);
    for (const s of found) {
      if (!s.trim() || seen.has(s)) continue;
      seen.add(s);
      keys.push(s);
      files[s] = relative(root, file).split(sep).join('/');
    }
  }
  return { keys, files, problems };
}

const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const bolds = (s) => (s.match(/\*\*/g) || []).length;

async function dictionary(code) {
  const file = join(DICTIONARIES, `${code}.js`);
  if (!existsSync(file)) return {};
  return (await import(`${pathToFileURL(file).href}?${Date.now()}`)).default || {};
}

function writeDictionary(code, dict, keys) {
  const lines = keys.filter((k) => typeof dict[k] === 'string' && dict[k].trim()).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(dict[k])},`);
  const body = `// ${LANGS[code] || code}. The app's English → its translation
// (src/ui/i18n.js). Checked, and added to, with scripts/i18n.mjs.
export default {
${lines.join('\n')}
};
`;
  writeFileSync(join(DICTIONARIES, `${code}.js`), body);
  return lines.length;
}

const args = process.argv.slice(2);
const { keys, files: where, problems } = english();

if (args[0] === '--keys') {
  process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
} else if (args[0] === '--missing') {
  const dict = await dictionary(args[1] || 'es');
  const missing = keys.filter((k) => typeof dict[k] !== 'string' || !dict[k].trim()).map((text) => ({ text, file: where[text] }));
  process.stdout.write(`${JSON.stringify(missing, null, 1)}\n`);
} else if (args[0] === '--write') {
  const [, code, json] = args;
  if (!code || !json) throw new Error('Usage: node scripts/i18n.mjs --write <code> <translations.json>');
  const merged = { ...(await dictionary(code)), ...JSON.parse(readFileSync(json, 'utf8')) };
  console.log(`Wrote src/ui/i18n/${code}.js: ${writeDictionary(code, merged, keys)} of ${keys.length}`);
} else {
  let bad = problems.length;
  for (const p of problems) console.log(p);
  console.log(`${keys.length} pieces of English`);
  for (const code of Object.keys(LANGS)) {
    const dict = await dictionary(code);
    const missing = keys.filter((k) => typeof dict[k] !== 'string' || !dict[k].trim());
    const unused = Object.keys(dict).filter((k) => !keys.includes(k));
    const wrong = keys.filter((k) => typeof dict[k] === 'string' && (names(k) !== names(dict[k]) || bolds(k) !== bolds(dict[k])));
    console.log(`${code}: ${keys.length - missing.length} translated, ${missing.length} missing, ${unused.length} unused, ${wrong.length} with {names} or **bold** unlike the English`);
    for (const k of missing.slice(0, 20)) console.log(`  missing: ${JSON.stringify(k)}`);
    if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);
    for (const k of wrong) console.log(`  unlike the English: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
    for (const k of unused.slice(0, 20)) console.log(`  unused: ${JSON.stringify(k)}`);
    bad += missing.length + wrong.length;
  }
  process.exit(bad ? 1 : 0);
}
