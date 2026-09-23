// Keep the computer from going to sleep while Holly Computer runs, so the phone
// can always reach it and bots can finish their work. Each helper watches this
// process and exits with it.

import { spawn } from 'node:child_process';
import { which } from './desktop.mjs';

export function keepAwake({ platform = process.platform } = {}) {
  const pid = process.pid;
  let child = null;
  try {
    if (platform === 'darwin') {
      // -i: no idle sleep; -w: stop when Holly Computer exits
      child = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
    } else if (platform === 'win32') {
      const ps = `Add-Type -Name P -Namespace HollyAwake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';
[HollyAwake.P]::SetThreadExecutionState(0x80000001) | Out-Null
while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`;
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    } else if (which('systemd-inhibit')) {
      child = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=Holly Computer', '--why=Your bots are working', '--mode=block',
        'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 20; done`], { stdio: 'ignore' });
    }
  } catch {
    child = null;
  }
  child?.on('error', () => {});
  child?.unref();
  return {
    active: !!child,
    stop() {
      try {
        child?.kill();
      } catch { /* already gone */ }
    },
  };
}
