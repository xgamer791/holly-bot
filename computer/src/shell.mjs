// Shell command execution for Holly Bot Computer: streams output, enforces
// timeouts (killing the whole process tree), and can start background jobs.

import { spawn, spawnSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_OUTPUT = 400 * 1024;

export function detectShell() {
  if (process.platform === 'win32') {
    const pwsh = spawnSync('where', ['pwsh.exe'], { encoding: 'utf8' });
    const exe = pwsh.status === 0 ? 'pwsh.exe' : 'powershell.exe';
    return { name: exe.replace('.exe', ''), exe, args: (cmd) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd] };
  }
  const sh = process.env.SHELL && !/fish$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  return { name: sh.split('/').pop(), exe: sh, args: (cmd) => ['-lc', cmd] };
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch { /* gone */ }
  }
}

/**
 * Run a command. onData(stream, text) receives output as it arrives.
 * Resolves { stdout, stderr, code, signal, durationMs, cwd, timedOut }.
 */
export function runCommand(command, { cwd, timeoutMs = 120000, onData, signal, env } = {}) {
  const shell = detectShell();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(shell.exe, shell.args(command), {
      cwd,
      // Nobody can type into a prompt here: git fails at once instead of
      // waiting out the timeout for a username (a private repository).
      env: { GIT_TERMINAL_PROMPT: '0', ...process.env, ...env, HOLLY_BOT: '1' },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s) => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout = cap(stdout + d);
      onData?.('stdout', d);
    });
    child.stderr.on('data', (d) => {
      stderr = cap(stderr + d);
      onData?.('stderr', d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\n[killed after ${Math.round(timeoutMs / 1000)}s timeout]`;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      stderr += '\n[stopped]';
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${err.message}`, code: 127, signal: null, durationMs: Date.now() - started, cwd, timedOut });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, signal: sig, durationMs: Date.now() - started, cwd, timedOut });
    });
  });
}

/** Start a long-running command in the background; output goes to a log file. */
export function startBackground(command, { cwd, logDir }) {
  const shell = detectShell();
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `job-${Date.now()}.log`);
  const fd = openSync(logFile, 'a');
  const child = spawn(shell.exe, shell.args(command), { cwd, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, HOLLY_BOT: '1' } });
  child.unref();
  return { pid: child.pid, logFile };
}
