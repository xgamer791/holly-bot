// Regenerates the browser bundles in vendor/ from pinned npm packages.
// The app itself has no build step: these files are committed and served as-is.
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tmp = join(root, '.vendor-tmp');
mkdirSync(tmp, { recursive: true });

const entries = {
  'preact.js': `
    import { h, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray } from 'preact';
    import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useErrorBoundary, useId } from 'preact/hooks';
    import htm from 'htm';
    const html = htm.bind(h);
    export { h, html, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray,
      useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useErrorBoundary, useId };
  `,
  'markdown.js': `
    import { marked } from 'marked';
    import DOMPurify from 'dompurify';
    export { marked, DOMPurify };
  `,
  'anthropic-sdk.js': `export { default as Anthropic } from '@anthropic-ai/sdk';`,
  'convex.js': `export { ConvexHttpClient } from 'convex/browser';`,
};

for (const [out, src] of Object.entries(entries)) {
  const entry = join(tmp, out.replace('.js', '.entry.js'));
  writeFileSync(entry, src);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'browser',
    target: 'es2020',
    outfile: join(root, 'vendor', out),
    nodePaths: [join(root, 'node_modules')],
    legalComments: 'eof',
  });
  console.log('built vendor/' + out);
}
rmSync(tmp, { recursive: true, force: true });
