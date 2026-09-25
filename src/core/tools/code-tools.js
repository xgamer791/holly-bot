import { truncateMiddle } from '../util.js';
import { isTextPath } from '../files.js';
import { blobBase64 } from './file-tools.js';
import { phrase } from '../i18n.js';

// Code execution in the browser: Python via Pyodide (with numpy, pandas,
// matplotlib…) and plain JavaScript. The bot's drive is the working directory.

const MAX_INPUT_FILE = 8 * 1024 * 1024;

export const codeTools = [
  {
    name: 'run_python',
    group: 'code',
    available: (app) => typeof Worker !== 'undefined' && app.host !== 'computer',
    label: () => phrase('Ran Python'),
    description: 'Run Python 3 code in a sandbox (Pyodide/WebAssembly) for calculations, data analysis, charts and file processing. '
      + 'numpy, pandas, matplotlib, scipy, scikit-learn and many other packages load automatically from imports; install pure-Python packages with `import micropip; await micropip.install("pkg")`. '
      + 'Your drive is the working directory: read files by relative path, and files you create are saved back to your drive. Charts made with matplotlib are shown to the user automatically. '
      + 'Print results you want to see. No network access to arbitrary sites (browser CORS rules apply) and no shell.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    async run(args, ctx) {
      const { runPython, sandboxAvailable } = await import('../sandbox/index.js');
      if (!sandboxAvailable()) return { content: 'Python sandbox is not available in this environment.', isError: true };
      const stored = await ctx.app.files.list(ctx.agent.id);
      const files = [];
      for (const meta of stored) {
        if (meta.size > MAX_INPUT_FILE) continue;
        const f = await ctx.app.files.getById(meta.id);
        const data = f.text != null ? f.text : new Uint8Array(await f.blob.arrayBuffer());
        files.push({ path: f.path, data });
      }
      const res = await runPython(args.code, {
        files,
        signal: ctx.signal,
        onStatus: (s) => ctx.progress?.(s),
      });
      const saved = [];
      for (const f of res.files || []) {
        const isText = isTextPath(f.path);
        const content = isText ? new TextDecoder().decode(f.data) : new Blob([f.data]);
        const file = await ctx.app.files.write(ctx.agent.id, f.path, content);
        saved.push(file.path);
      }
      const images = (res.images || []).map((data) => ({ mime: 'image/png', data }));
      for (let i = 0; i < images.length; i++) {
        const bytes = Uint8Array.from(atob(images[i].data), (c) => c.charCodeAt(0));
        await ctx.app.files.write(ctx.agent.id, `charts/chart-${Date.now()}-${i + 1}.png`, new Blob([bytes], { type: 'image/png' }));
      }
      const out = [
        res.stdout && `stdout:\n${truncateMiddle(res.stdout, 12000)}`,
        res.stderr && `stderr:\n${truncateMiddle(res.stderr, 4000)}`,
        res.result && `result: ${truncateMiddle(res.result, 4000)}`,
        res.error && `error:\n${truncateMiddle(res.error, 6000)}`,
        saved.length && `files saved: ${saved.join(', ')}`,
        images.length && `${images.length} chart(s) shown to the user`,
      ].filter(Boolean).join('\n\n') || '(no output — print what you want to see)';
      return {
        content: out,
        isError: !!res.error,
        images,
        display: { kind: 'code', language: 'python', code: args.code, stdout: res.stdout, stderr: res.stderr, error: res.error, result: res.result, images: images.length, saved },
      };
    },
  },
  {
    name: 'run_javascript',
    group: 'code',
    available: (app) => typeof Worker !== 'undefined' && app.host !== 'computer',
    label: () => phrase('Ran JavaScript'),
    description: 'Run JavaScript (async function body) in a sandboxed worker. Use console.log for output; the return value is shown. fetch() works for CORS-enabled URLs. No DOM or access to app data.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    async run(args, ctx) {
      const { runJavaScript, sandboxAvailable } = await import('../sandbox/index.js');
      if (!sandboxAvailable()) return { content: 'JavaScript sandbox is not available.', isError: true };
      const res = await runJavaScript(args.code, { signal: ctx.signal });
      const logs = (res.logs || []).join('\n');
      const out = [
        logs && `console:\n${truncateMiddle(logs, 12000)}`,
        res.result != null && `result: ${truncateMiddle(res.result, 6000)}`,
        res.error && `error:\n${truncateMiddle(res.error, 4000)}`,
      ].filter(Boolean).join('\n\n') || '(no output)';
      return {
        content: out,
        isError: !!res.error,
        display: { kind: 'code', language: 'javascript', code: args.code, stdout: logs, error: res.error, result: res.result },
      };
    },
  },
];

export { blobBase64 };
