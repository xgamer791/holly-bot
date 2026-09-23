// Runs the browser end-to-end tests (tests/e2e/*.e2e.mjs) with node:test.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const dir = new URL('../tests/e2e/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.e2e.mjs')).map((f) => dir + f);
const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: process.env });
process.exit(res.status ?? 1);
