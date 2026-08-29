/**
 * Real-world benchmark (large): MUI v9 — @mui/material + @mui/icons-material
 * prebuilt ESM from npm, bundled by rolldown with react externalized into
 * globals. ~11600 modules / ~7.4 MiB graph.
 *
 * Corpus preparation (once):
 *   mkdir mui && cd mui && npm init -y
 *   npm i @mui/material@9.3.1 @mui/icons-material@9.3.1 \
 *         @emotion/react @emotion/styled react react-dom
 *   printf "import * as MUI from '@mui/material';\nimport * as Icons from '@mui/icons-material';\nexport default { MUI, Icons };\n" > entry.mjs
 */
import { rolldown } from 'rolldown';
import originalPlugin from 'rollup-plugin-external-globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { externalGlobals } from '../plugin.mjs';

const ROOT = process.env.MUI_DIR || join(process.cwd(), '..', 'eg-real-bench', 'mui');
const ENTRY = join(ROOT, 'entry.mjs');
if (!existsSync(ENTRY)) {
  console.error(`corpus not found at ${ENTRY}; see header for preparation steps.`);
  process.exit(1);
}

const globals = {
  react: 'React',
  'react-dom': 'ReactDOM',
  'react/jsx-runtime': 'React',
  'react/jsx-dev-runtime': 'React',
};
const RUNS = Number(process.env.EG_RUNS || 2);

async function build(plugins) {
  const bundle = await rolldown({
    input: ENTRY,
    cwd: ROOT,
    plugins,
    onLog: () => {},
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  return output[0].code;
}

async function bench(plugins) {
  await build(plugins); // warmup
  const times = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    await build(plugins);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[0];
}

function assertTransformed(label, code) {
  if (/from ["']react["']/.test(code) || /from ["']react\/jsx-runtime["']/.test(code)) {
    throw new Error(`${label}: a react import survived`);
  }
  if (!/React\.(jsx|createElement|useState|forwardRef)/.test(code)) {
    throw new Error(`${label}: no React.* references found`);
  }
}

console.log(`corpus: MUI v9 prebuilt ESM (entry ${ENTRY})\n`);

const codeOrig = await build([originalPlugin(globals)]);
assertTransformed('original', codeOrig);
const codeNative = await build([externalGlobals(globals)]);
assertTransformed('native', codeNative);
console.log(
  `sanity ok — outputs identical: ${codeOrig === codeNative} ` +
    `(${(codeNative.length / 1048576).toFixed(1)} MiB bundle)\n`,
);

const tOrig = await bench([originalPlugin(globals)]);
const tNative = await bench([externalGlobals(globals)]);
console.log(`rolldown + original JS plugin: ${tOrig.toFixed(0)} ms`);
console.log(`rolldown + native Rust plugin: ${tNative.toFixed(0)} ms`);
console.log(`speedup: ${(tOrig / tNative).toFixed(2)}x`);
