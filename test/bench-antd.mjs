/**
 * Real-world benchmark: ant-design v6 (compiled from TSX to JS, as a real
 * build pipeline does before external-globals runs). Bundles all antd
 * components plus their @rc-component/* dependency tree with rolldown,
 * externalizing react/react-dom into globals.
 *
 * Compares the original JS plugin vs the native Rust plugin.
 *
 * Corpus preparation (once):
 *   git clone --depth 1 https://github.com/ant-design/ant-design.git <ANTD_DIR>
 *   cd <ANTD_DIR> && npm install --omit=dev
 *   # antd generates components/version/version.ts at build time:
 *   echo "export default '0.0.0';" > components/version/version.ts
 *   npx esbuild $(find components -name '*.ts' -o -name '*.tsx' \
 *     | grep -v __tests__ | grep -v /demo/) \
 *     --outdir=.compiled --format=esm --jsx=automatic --target=es2020
 *
 * The compiled output MUST live inside the antd checkout so node_modules
 * resolution finds @rc-component/* and friends.
 */
import { rolldown } from 'rolldown';
import originalPlugin from 'rollup-plugin-external-globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { externalGlobals } from '../plugin.mjs';

const ROOT = process.env.ANTD_DIR || join(process.cwd(), '..', 'eg-real-bench', 'antd');
// compiled output lives INSIDE the antd checkout so node_modules resolution works
const ENTRY = process.env.ANTD_ENTRY || join(ROOT, '.compiled', 'index.js');
if (!existsSync(ENTRY)) {
  console.error(`compiled corpus not found at ${ENTRY}; set ANTD_COMPILED.`);
  process.exit(1);
}

const globals = {
  react: 'React',
  'react-dom': 'ReactDOM',
  'react-dom/server': 'ReactDOMServer',
};
const RUNS = Number(process.env.EG_RUNS || 2);

async function build(plugins) {
  const bundle = await rolldown({
    input: ENTRY,
    cwd: ROOT, // resolve @rc-component/* & co. from antd's node_modules
    plugins,
    onLog: () => {}, // silence "treating as external" noise
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
  return times[0]; // best of RUNS
}

function assertTransformed(label, code) {
  if (/from ["']react["']/.test(code)) throw new Error(`${label}: a react import survived`);
  if (!/React\.createElement|React\.\w+/.test(code)) {
    throw new Error(`${label}: no React.* references found`);
  }
}

console.log(`corpus: ant-design compiled JS (entry ${ENTRY})\n`);

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
