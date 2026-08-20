#!/usr/bin/env node
/**
 * Build the DSH client half of dsh-version-autoupdate.
 *
 * DSH's client plugins ship a browser-side bundle in the shape produced by the
 * harness build pipeline:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package-name>",
 *     factory: (require) => { ... return module.exports }
 *   });
 *
 * The `factory` runs in a CJS-like scope where `require` resolves against the
 * runtime module table ("seed" words such as `react`, plus dynamically
 * registered plugin bundles). We transpile `src/client.tsx` to CommonJS with
 * TypeScript's own compiler (no extra bundler dependency), then wrap it in that
 * loader contract. The only runtime dependency is `react` (the ClientContext
 * import is type-only and erased), which every official DSH client bundle also
 * requires through the same `require("react")` seed.
 *
 * Output: lib/client.js (+ lib/client.js.map for the source-map route).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsPath = require.resolve('typescript');
const ts = require(tsPath);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'client.tsx');
const OUT = join(ROOT, 'lib', 'client.js');
const OUT_MAP = OUT + '.map';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const id = pkg.name;

const source = readFileSync(SRC, 'utf8');

const result = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
    sourceMap: true,
    inlineSources: false,
    mapRoot: undefined,
    sourceRoot: undefined,
    fileName: 'client.tsx',
    // We hand-control the final wrapping; keep TypeScript from emitting its own
    // "use client"/filename assumptions.
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmitOnError: true,
  },
  reportDiagnostics: true,
  fileName: 'client.tsx',
});

if (result.diagnostics && result.diagnostics.length > 0) {
  const errs = result.diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  if (errs.length > 0) {
    console.error('build-client: TypeScript errors in src/client.tsx:');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
}

let body = result.outputText;

// The CJS output begins with a "use strict" directive and references `exports`,
// `require`, and the CJS helper functions in the top-level scope. The loader
// factory supplies `require`, `module`, and `exports`, so the body is wrapped
// verbatim. Emit a source map whose `sources` point back to client.tsx.
const mapJson = result.sourceMapText;
let mapFile = null;
if (mapJson) {
  const raw = JSON.parse(mapJson);
  raw.file = 'client.js';
  raw.sources = ['../../src/client.tsx'];
  writeFileSync(OUT_MAP, JSON.stringify(raw));
  mapFile = '\n//# sourceMappingURL=client.js.map';
}

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
});${mapFile ? '\n' + mapFile : ''}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);
console.log(`build-client: wrote ${OUT} (${bundle.length} bytes)`);
if (mapFile) console.log(`build-client: wrote ${OUT_MAP}`);
