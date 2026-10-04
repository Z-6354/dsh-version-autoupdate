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
mkdirSync(dirname(OUT), { recursive: true });

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const id = pkg.name;

const result = esbuild.buildSync({
  entryPoints: [ENTRY],
  outfile: OUT,
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

const body = jsFile.text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');

const prefix = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;

const mapFooter = mapFile
  ? (() => {
    const raw = JSON.parse(mapFile.text);
    // An indexed map preserves esbuild's coordinates after adding the loader prefix.
    writeFileSync(OUT_MAP, JSON.stringify({
      version: 3, file: 'client.js',
      sections: [{ offset: { line: prefix.split('\n').length - 1, column: 0 }, map: raw }],
    }));
    return '\n//# sourceMappingURL=client.js.map';
  })()
  : '';

const bundle = `${prefix}${body}
\t\treturn module.exports;
\t}
});${mapFooter}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);
console.log(`build-client: wrote ${OUT} (${bundle.length} bytes)`);
if (mapFooter) console.log(`build-client: wrote ${OUT_MAP}`);
