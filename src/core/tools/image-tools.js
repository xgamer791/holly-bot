import { truncate } from '../util.js';

// Image generation through whichever connected provider supports it.

export const imageTools = [
  {
    name: 'generate_image',
    group: 'images',
    available: (app) => !!app.providers.imageProvider(),
    label: (a) => `Generated “${truncate(a.prompt || '', 40)}”`,
    description: 'Create an image from a detailed text prompt. The image is shown to the user and saved to your drive (images/).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description: subject, style, composition, lighting, text to include.' },
        filename: { type: 'string', description: 'Optional file name, e.g. "logo.png".' },
      },
      required: ['prompt'],
    },
    async run(args, ctx) {
      const img = await ctx.app.providers.generateImage(args.prompt, { signal: ctx.signal });
      const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
      const name = (args.filename || `image-${Date.now()}.png`).replace(/[^\w.-]+/g, '-');
      const file = await ctx.app.files.write(ctx.agent.id, `images/${name}`, new Blob([bytes], { type: img.mime }));
      return {
        content: `Image created with ${img.model} and saved as ${file.path}. It is already visible to the user${img.revisedPrompt ? `; revised prompt: ${img.revisedPrompt}` : ''}.`,
        display: { kind: 'image', fileId: file.id, path: file.path, model: img.model },
      };
    },
  },
];
