// Python sandbox (Pyodide / WebAssembly) running in a dedicated worker.
// The bot's drive is copied into the working directory before each run and
// new or changed files are sent back afterwards.

const PYODIDE_VERSION = '0.29.5';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const WORK = '/home/pyodide/work';

let ready = null;

async function boot() {
  const { loadPyodide } = await import(`${INDEX_URL}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: INDEX_URL });
  py.FS.mkdirTree(WORK);
  return py;
}

function walk(py, dir, base = '') {
  const out = [];
  for (const name of py.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const rel = base ? `${base}/${name}` : name;
    const st = py.FS.stat(full);
    if (py.FS.isDir(st.mode)) out.push(...walk(py, full, rel));
    else out.push({ path: rel, mtime: st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime), size: st.size });
  }
  return out;
}

function rmrf(py, dir) {
  for (const name of py.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    if (py.FS.isDir(py.FS.stat(full).mode)) {
      rmrf(py, full);
      py.FS.rmdir(full);
    } else py.FS.unlink(full);
  }
}

const FIGURES = `
import sys, io, base64
_holly_imgs = []
if 'matplotlib.pyplot' in sys.modules:
    import matplotlib.pyplot as _plt
    for _n in _plt.get_fignums():
        _buf = io.BytesIO()
        _plt.figure(_n).savefig(_buf, format='png', dpi=110, bbox_inches='tight')
        _holly_imgs.append(base64.b64encode(_buf.getvalue()).decode())
    _plt.close('all')
_holly_imgs
`;

self.onmessage = async (e) => {
  const { id, code, files = [] } = e.data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    if (!ready) {
      post({ status: 'Starting Python (first run downloads ~10 MB)…' });
      ready = boot();
    }
    const py = await ready;
    let stdout = '';
    let stderr = '';
    py.setStdout({ batched: (s) => { stdout += `${s}\n`; } });
    py.setStderr({ batched: (s) => { stderr += `${s}\n`; } });

    rmrf(py, WORK);
    for (const f of files) {
      const full = `${WORK}/${f.path}`;
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      py.FS.writeFile(full, f.data);
    }
    py.FS.chdir(WORK);
    const before = new Map(walk(py, WORK).map((f) => [f.path, f.mtime]));

    post({ status: 'Loading packages…' });
    try {
      await py.loadPackagesFromImports(code);
    } catch (err) {
      stderr += `Package load warning: ${err.message}\n`;
    }
    if (/matplotlib/.test(code)) await py.runPythonAsync("import matplotlib\nmatplotlib.use('AGG')");

    post({ status: 'Running…' });
    let result = null;
    let error = null;
    try {
      const value = await py.runPythonAsync(code);
      if (value !== undefined && value !== null) {
        result = typeof value?.toString === 'function' ? value.toString() : String(value);
        if (value?.destroy) value.destroy();
      }
    } catch (err) {
      error = String(err.message || err);
    }

    let images = [];
    try {
      const proxy = await py.runPythonAsync(FIGURES);
      images = proxy.toJs();
      proxy.destroy();
    } catch { /* no figures */ }

    const changed = [];
    for (const f of walk(py, WORK)) {
      if (before.get(f.path) === f.mtime) continue;
      if (f.size > 20 * 1024 * 1024) continue;
      changed.push({ path: f.path, data: py.FS.readFile(`${WORK}/${f.path}`) });
    }
    post({ done: true, stdout, stderr, result, error, images, files: changed });
  } catch (err) {
    post({ done: true, error: `Python sandbox failed to start: ${err.message || err}`, stdout: '', stderr: '', images: [], files: [] });
  }
};
