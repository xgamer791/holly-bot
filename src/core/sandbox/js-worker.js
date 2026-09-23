// JavaScript sandbox: runs bot-written code in a worker (no DOM, no app data).

const fmt = (v) => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
};

self.onmessage = async (e) => {
  const { id, code } = e.data;
  const logs = [];
  const log = (level) => (...args) => logs.push(`${level === 'log' ? '' : `[${level}] `}${args.map(fmt).join(' ')}`);
  self.console = { ...console, log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const value = await new AsyncFunction(code)();
    self.postMessage({ id, done: true, logs, result: value === undefined ? null : fmt(value) });
  } catch (err) {
    self.postMessage({ id, done: true, logs, error: String(err?.stack || err) });
  }
};
