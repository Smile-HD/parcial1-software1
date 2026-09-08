/**
 * Golden-generate helper for tools/golden-check.mjs (unit 14b).
 *
 * Loads the golden reference diagram, runs `generate()` with the REAL
 * Handlebars renderer, writes every generated file into the sandbox directory
 * given as argv[2], and drops a `.golden-manifest.json` mapping each written
 * path back to its template id (so the check can name the offending template
 * when the Maven build fails — codegen:R5 "fails loudly").
 *
 * Run via `node --import tsx tools/golden-generate.ts <sandboxDir>` from
 * packages/codegen (so the tsx loader and the workspace deps resolve).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DiagramSchema } from '../packages/core/src/ir.js';
import { generate } from '../packages/codegen/src/generate.js';
import { createHandlebarsRenderer } from '../packages/codegen/src/render.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandboxDir = process.argv[2];
if (!sandboxDir) {
  console.error('usage: golden-generate.ts <sandboxDir>');
  process.exit(2);
}

const diagram = DiagramSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, 'golden', 'reference-diagram.json'), 'utf8')),
);
const result = generate(diagram, {
  outputRoot: sandboxDir,
  render: createHandlebarsRenderer(),
});

if (result.warnings.length > 0) {
  console.error('golden diagram produced warnings — the fixture must stay clean:');
  for (const w of result.warnings) console.error(`  [${w.code}] ${w.message}`);
  process.exit(1);
}

for (const file of result.files) {
  const abs = join(sandboxDir, ...file.path.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, file.content, 'utf8');
}

writeFileSync(
  join(sandboxDir, '.golden-manifest.json'),
  JSON.stringify(
    { files: result.files.map((f) => ({ path: f.path, template: f.template, kind: f.kind })) },
    null,
    2,
  ),
  'utf8',
);
console.log(`golden-generate: wrote ${result.files.length} files to ${sandboxDir}`);
