import { formatBytes, truncateMiddle } from '../util.js';
import { isTextPath } from '../files.js';

// A bot's own drive: create, read, list and delete files.

export const fileTools = [
  {
    name: 'list_files',
    group: 'files',
    label: () => 'Listed files',
    description: 'List the files in your drive (optionally under a folder).',
    parameters: { type: 'object', properties: { folder: { type: 'string' } } },
    async run(args, ctx) {
      const files = await ctx.app.files.list(ctx.agent.id, args.folder || '');
      if (!files.length) return { content: args.folder ? `No files under ${args.folder}.` : 'Your drive is empty.' };
      return { content: files.map((f) => `${f.path}  (${formatBytes(f.size)}, ${f.mime}, updated ${new Date(f.updatedAt).toISOString().slice(0, 16).replace('T', ' ')})`).join('\n') };
    },
  },
  {
    name: 'read_file',
    group: 'files',
    label: (a) => `Read ${a.path}`,
    description: 'Read a text file from your drive. Long files are truncated in the middle; use offset/length to page.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from.' },
        length: { type: 'integer', minimum: 100, maximum: 60000 },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const f = await ctx.app.files.get(ctx.agent.id, args.path);
      if (!f) return { content: `No file at ${args.path}.`, isError: true };
      if (!isTextPath(f.path, f.mime) && f.text == null) {
        if (f.mime?.startsWith('image/') && f.blob) {
          const data = await blobBase64(f.blob);
          return { content: `Image ${f.path} (${formatBytes(f.size)}) attached.`, images: [{ mime: f.mime, data }] };
        }
        return { content: `${f.path} is a binary file (${f.mime}, ${formatBytes(f.size)}); it cannot be shown as text.` };
      }
      const text = f.text ?? await f.blob.text();
      const start = args.offset || 0;
      const len = args.length || 30000;
      const slice = text.slice(start, start + len);
      const more = start + len < text.length ? `\n\n[${text.length - start - len} more characters — call again with offset ${start + len}]` : '';
      return { content: (start ? slice : truncateMiddle(slice, len)) + more };
    },
  },
  {
    name: 'write_file',
    group: 'files',
    label: (a) => `Wrote ${a.path}`,
    description: 'Create or overwrite a text file in your drive (notes, reports, code, CSV, HTML…). Set append=true to add to the end instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "reports/summary.md"' },
        content: { type: 'string' },
        append: { type: 'boolean' },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      let content = args.content ?? '';
      if (args.append) {
        const prev = await ctx.app.files.readText(ctx.agent.id, args.path);
        content = (prev ?? '') + content;
      }
      const f = await ctx.app.files.write(ctx.agent.id, args.path, content);
      return { content: `Saved ${f.path} (${formatBytes(f.size)}).`, display: { kind: 'file_saved', fileId: f.id, path: f.path, size: f.size } };
    },
  },
  {
    name: 'delete_file',
    group: 'files',
    label: (a) => `Deleted ${a.path}`,
    description: 'Delete a file from your drive.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(args, ctx) {
      const ok = await ctx.app.files.remove(ctx.agent.id, args.path);
      return ok ? { content: `Deleted ${args.path}.` } : { content: `No file at ${args.path}.`, isError: true };
    },
  },
];

export async function blobBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
