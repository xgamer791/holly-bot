// Creates CONNECTORS_KEY on Holly Bot's Convex deployment: the key that seals
// the Gmail, Outlook and GitHub connections people make for their bots
// (convex/lib/seal.ts). 32 random bytes in base64, handed to
// `npx convex env set` on stdin: never printed, written to disk or committed.
//
//   node scripts/convex-connectors-key.mjs --if-missing   only when it isn't set yet (the deploy workflow)
//   node scripts/convex-connectors-key.mjs                a new key, which disconnects everyone's accounts
//
// The deployment is the one CONVEX_DEPLOY_KEY (CI) or `npx convex dev` points at.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ifMissing = process.argv.includes('--if-missing');

function convex(args, input) {
  const res = spawnSync('npx', ['convex', ...args], {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  });
  if (res.status !== 0) {
    console.error(`npx convex ${args.join(' ')} failed`);
    process.exit(res.status || 1);
  }
  return res.stdout;
}

if (ifMissing) {
  const names = new Set(convex(['env', 'list', '--names-only']).split(/\r?\n/).map((line) => line.trim()));
  if (names.has('CONNECTORS_KEY')) {
    console.log('CONNECTORS_KEY is already set; leaving it alone.');
    process.exit(0);
  }
}

convex(['env', 'set', 'CONNECTORS_KEY'], randomBytes(32).toString('base64'));
console.log(`Set CONNECTORS_KEY.${ifMissing ? '' : ' Connections sealed with the old key no longer open: everyone connects Gmail, Outlook and GitHub again.'}`);
