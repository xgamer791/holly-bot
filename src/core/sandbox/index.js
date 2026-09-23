// Manages the Python (Pyodide) and JavaScript sandbox workers.

const PY_TIMEOUT = 120000;
const JS_TIMEOUT = 20000;

class WorkerPool {
  constructor(url, timeout) {
    this.url = url;
    this.timeout = timeout;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  spawn() {
    const w = new Worker(this.url, { type: 'module' });
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      if (e.data.status) {
        p.onStatus?.(e.data.status);
        return;
      }
      if (e.data.done) {
        clearTimeout(p.timer);
        this.pending.delete(e.data.id);
        p.resolve(e.data);
      }
    };
    w.onerror = (e) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(e.message || 'Sandbox worker crashed'));
      }
      this.pending.clear();
      this.worker = null;
    };
    return w;
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
  }

  /** Runs one job at a time (the Python interpreter is single-threaded). */
  run(payload, { onStatus, signal } = {}) {
    const job = () => new Promise((resolve, reject) => {
      if (!this.worker) this.worker = this.spawn();
      const id = ++this.seq;
      const fail = (err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.kill();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`Timed out after ${this.timeout / 1000}s (sandbox restarted)`)), this.timeout);
      signal?.addEventListener('abort', () => fail(new DOMException('Stopped', 'AbortError')), { once: true });
      this.pending.set(id, { resolve, reject, timer, onStatus });
      this.worker.postMessage({ id, ...payload });
    });
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }
}

let py = null;
let js = null;

export function sandboxAvailable() {
  return typeof Worker !== 'undefined';
}

export async function runPython(code, { files = [], onStatus, signal } = {}) {
  py ||= new WorkerPool(new URL('./py-worker.js', import.meta.url), PY_TIMEOUT);
  return py.run({ code, files }, { onStatus, signal });
}

export async function runJavaScript(code, { signal } = {}) {
  js ||= new WorkerPool(new URL('./js-worker.js', import.meta.url), JS_TIMEOUT);
  return js.run({ code }, { signal });
}

export function resetSandboxes() {
  py?.kill();
  js?.kill();
}
