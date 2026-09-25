// How much of the computer's memory (RAM) is in use, counted the way its own
// system monitor counts it, for the RAM meter under the Screen tab
// (src/ui/computer.js, GET /v1/memory). Every computer Holly Computer runs on:
// - Windows: Task Manager's Memory in use (fromNode)
// - Linux: /proc/meminfo, the total less MemAvailable (what `free` counts as used)
// - macOS: vm_stat, Activity Monitor's Memory Used (app memory, wired and compressed)
// - anything else, or when those can't be read: Node's own count (fromNode)

import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** { total, used, swapTotal, swapUsed }, in bytes. */
export async function memoryUsage() {
  if (process.platform === 'win32') return fromNode();
  try {
    if (process.platform === 'linux') return fromMeminfo(await readFile('/proc/meminfo', 'utf8'));
    if (process.platform === 'darwin') {
      const [vm, swap] = await Promise.all([run('vm_stat'), run('sysctl', ['-n', 'vm.swapusage']).catch(() => '')]);
      return { ...fromVmStat(vm, os.totalmem()), ...fromSwapUsage(swap) };
    }
  } catch { /* Node's own count, below */ }
  return fromNode();
}

/**
 * Node's count of physical memory. On Windows os.totalmem() and os.freemem()
 * are GlobalMemoryStatusEx's total and available physical memory, the same
 * numbers Task Manager shows (Memory 6.2/15.8 GB, 39%); the page file isn't
 * counted. On Linux, Node reads MemAvailable too.
 */
function fromNode() {
  const total = os.totalmem();
  return { total, used: clamp(total - os.freemem(), total), swapTotal: 0, swapUsed: 0 };
}

/** /proc/meminfo's numbers (in kB) as memory and swap in use. */
export function fromMeminfo(text) {
  const kb = {};
  for (const m of text.matchAll(/^([\w()]+):\s+(\d+)/gm)) kb[m[1]] = Number(m[2]) * 1024;
  if (!kb.MemTotal) throw new Error('/proc/meminfo has no MemTotal');
  // Kernels before 3.14 don't give MemAvailable: count what they could free.
  const available = kb.MemAvailable ?? ((kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0) + (kb.SReclaimable || 0) - (kb.Shmem || 0));
  const swapTotal = kb.SwapTotal || 0;
  return {
    total: kb.MemTotal,
    used: clamp(kb.MemTotal - available, kb.MemTotal),
    swapTotal,
    swapUsed: clamp(swapTotal - (kb.SwapFree || 0), swapTotal),
  };
}

/** vm_stat's page counts as Activity Monitor's Memory Used: app memory
 * (anonymous pages less purgeable ones), wired, and what the compressor holds. */
export function fromVmStat(text, total) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]) || 4096;
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1]) || 0;
  const app = /^Anonymous pages:/m.test(text) ? pages('Anonymous pages') - pages('Pages purgeable') : pages('Pages active');
  const used = (Math.max(0, app) + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
  return { total, used: clamp(used, total) };
}

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)". */
export function fromSwapUsage(text) {
  const size = (name) => {
    const m = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(text);
    return m ? Number(m[1]) * 1024 ** ' KMGT'.indexOf(m[2]) : 0;
  };
  const swapTotal = Math.round(size('total'));
  return { swapTotal, swapUsed: clamp(size('used'), swapTotal) };
}

function clamp(n, max) {
  return Math.min(max, Math.max(0, Math.round(n)));
}

function run(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
