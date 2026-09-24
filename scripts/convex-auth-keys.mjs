// Creates the RS256 key pair Convex Auth signs sessions with and stores it on
// Holly Bot's Convex deployment as JWT_PRIVATE_KEY and JWKS. The private key is
// generated here and handed to `npx convex env set` on stdin: it is never
// printed, written to disk or committed.
//
//   node scripts/convex-auth-keys.mjs --if-missing   only when they aren't set yet (the deploy workflow)
//   node scripts/convex-auth-keys.mjs                rotate them, which signs everyone out
//
// The deployment is the one CONVEX_DEPLOY_KEY (CI) or `npx convex dev` points at.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

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
  if (names.has('JWT_PRIVATE_KEY') && names.has('JWKS')) {
    console.log('JWT_PRIVATE_KEY and JWKS are already set; leaving them alone.');
    process.exit(0);
  }
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
// Convex Auth reads the PEM with its line breaks turned into spaces.
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trimEnd().replace(/\n/g, ' ');
const jwks = JSON.stringify({ keys: [{ use: 'sig', ...publicKey.export({ format: 'jwk' }) }] });
convex(['env', 'set', 'JWT_PRIVATE_KEY'], pem);
convex(['env', 'set', 'JWKS'], jwks);
console.log(`Set JWT_PRIVATE_KEY and JWKS.${ifMissing ? '' : ' Everyone who was signed in is now signed out.'}`);
