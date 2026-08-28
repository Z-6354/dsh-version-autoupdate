#!/usr/bin/env node
/**
 * Bundle src/client.tsx (+ local imports) for DSH ModuleLoader.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(ROOT, 'src', 'client', 'apply.ts');
const OUT = join(ROOT, 'lib', 'client.js');
const OUT_MAP = OUT + '.map';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const id = pkg.name;

const result = esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['react'],
  minify: true,
  sourcemap: true,
  write: false,
  logLevel: 'warning',
});

if (!result.outputFiles?.length) {
  console.error('build-client: esbuild produced no output');
  process.exit(1);
}

const jsFile = result.outputFiles.find((f) => f.path.endsWith('.js') || f.path === '<stdout>');
const mapFile = result.outputFiles.find((f) => f.path.endsWith('.map'));
if (!jsFile) {
  console.error('build-client: missing JS output');
  process.exit(1);
}

let body = jsFile.text;
body = body.replace(/^"use strict";\s*/m, '');

const mapFooter = mapFile
  ? (() => {
    const raw = JSON.parse(mapFile.text);
    raw.file = 'client.js';
    writeFileSync(OUT_MAP, JSON.stringify(raw));
    return '\n//# sourceMappingURL=client.js.map';
  })()
  : '';

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body
  .split('\n')
  .map((l) => (l === '' ? '' : '\t\t' + l))
  .join('\n')}
\t\treturn module.exports;
\t}
});${mapFooter}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);
console.log(`build-client: wrote ${OUT} (${bundle.length} bytes)`);
if (mapFooter) console.log(`build-client: wrote ${OUT_MAP}`);
