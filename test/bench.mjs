/**
 * Benchmark: a 2x2 matrix of (rollup | rolldown) x (original JS plugin | native plugin).
 *
 * Every cell builds the identical corpus. For the rolldown cells we pass
 * `external` explicitly so all four runs do the same resolution work (the
 * original plugin's resolveId injection is a rollup-ism), isolating the
 * transform cost. For the rollup cells we rely on each plugin's own resolveId.
 */
import { rollup } from 'rollup';
import { rolldown } from 'rolldown';
import originalPlugin from 'rollup-plugin-external-globals';

import { externalGlobals } from '../plugin.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIBS = Number(process.env.EG_LIBS || 8); // number of external libraries mapped to globals
const MODULES = Number(process.env.EG_MODULES || 200); // number of source modules
const REFS_PER_MODULE = Number(process.env.EG_REFS || 120); // references to import bindings per module
const RUNS = Number(process.env.EG_RUNS || 3);

const globals = Object.fromEntries(Array.from({ length: LIBS }, (_, i) => [`lib-${i}`, `Lib${i}`]));
const libIds = Object.keys(globals);

function genModule(i) {
  const lib = i % LIBS;
  const lines = [`import lib${lib}, { fnA, fnB as renamed } from "lib-${lib}";`, `let acc${i} = 0;`];
  for (let k = 0; k < REFS_PER_MODULE; k++) {
    switch (k % 4) {
      case 0:
        lines.push(`acc${i} += lib${lib}.value${k};`);
        break;
      case 1:
        lines.push(`acc${i} += fnA(${k});`);
        break;
      case 2:
        lines.push(`acc${i} += renamed(${k}, lib${lib});`);
        break;
      case 3:
        lines.push(`if (acc${i} > ${k}) acc${i} = lib${lib}.clamp(acc${i});`);
        break;
    }
  }
  lines.push(`export const result${i} = acc${i};`);
  return lines.join('\n');
}

function genEntry() {
  const lines = [];
  for (let i = 0; i < MODULES; i++) lines.push(`export { result${i} } from "./mod${i}.js";`);
  return lines.join('\n');
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'eg-bench-'));
  const CHUNK = 250;
  for (let start = 0; start < MODULES; start += CHUNK) {
    const batch = [];
    for (let i = start; i < Math.min(start + CHUNK, MODULES); i++) {
      batch.push(writeFile(join(dir, `mod${i}.js`), genModule(i)));
    }
    await Promise.all(batch);
  }
  await writeFile(join(dir, 'entry.js'), genEntry());
  return dir;
}

// ---- builders -----------------------------------------------------------

async function buildRollup(dir, plugins) {
  const bundle = await rollup({ input: join(dir, 'entry.js'), plugins });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();
  return output[0].code;
}

async function buildRolldown(dir, plugins) {
  const bundle = await rolldown({
    input: join(dir, 'entry.js'),
    cwd: dir,
    plugins,
    external: libIds,
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  return output[0].code;
}

async function bench(build, dir, plugins) {
  await build(dir, plugins); // warmup
  const times = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    await build(dir, plugins);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[0]; // best of RUNS
}

// ---- sanity: every cell must be fully transformed ------------------------

function assertTransformed(label, code) {
  if (/from ["']lib-\d["']/.test(code)) {
    throw new Error(`${label}: output still contains lib imports`);
  }
  if (!code.includes('Lib0.fnA')) {
    throw new Error(`${label}: output missing rewritten references`);
  }
}

// ---- transform-only microbenchmark (pure plugin cost) --------------------

async function benchTransformOnly() {
  const { parseAst } = await import('rollup/parseAst');
  const { transformExternalGlobals } = await import('../index.js');

  const sources = Array.from({ length: MODULES }, (_, i) => genModule(i));

  const origPlugin = originalPlugin(globals);
  const ctx = { parse: parseAst, warn() {}, debug() {} };

  const timeFn = async (fn) => {
    await fn(); // warmup
    const t0 = performance.now();
    const reps = 5;
    for (let r = 0; r < reps; r++) await fn();
    return (performance.now() - t0) / reps;
  };

  const tOrig = await timeFn(async () => {
    for (const code of sources) {
      await origPlugin.transform.call(ctx, code, '/project/mod.js');
    }
  });
  const tNative = await timeFn(async () => {
    for (const code of sources) {
      transformExternalGlobals(code, { id: '/project/mod.js', globals });
    }
  });
  console.log(`transform-only (${MODULES} modules, plugin cost isolated):`);
  console.log(`  original JS plugin: ${tOrig.toFixed(1)} ms`);
  console.log(`  native Rust plugin: ${tNative.toFixed(1)} ms  (${(tOrig / tNative).toFixed(1)}x)`);
  console.log('');
}

// ---- run ----------------------------------------------------------------

const dir = await setup();
try {
  console.log(`corpus: ${MODULES} modules x ~${REFS_PER_MODULE} import-binding refs, ${LIBS} mapped libs\n`);
  await benchTransformOnly();

  const cells = [
    ['rollup  + original JS plugin', buildRollup, [originalPlugin(globals)]],
    ['rollup  + native Rust plugin', buildRollup, [externalGlobals(globals)]],
    ['rolldown+ original JS plugin', buildRolldown, [originalPlugin(globals)]],
    ['rolldown+ native Rust plugin', buildRolldown, [externalGlobals(globals)]],
  ];

  const results = [];
  for (const [label, build, plugins] of cells) {
    const code = await build(dir, plugins);
    assertTransformed(label, code);
    results.push([label, await bench(build, dir, plugins)]);
  }

  const ms = (n) => `${n.toFixed(1).padStart(8)} ms`;
  console.log('bundler   plugin                 time        speedup vs original');
  console.log('----------------------------------------------------------------------');
  const byBundler = {
    rollup: results.filter(([l]) => l.startsWith('rollup')),
    rolldown: results.filter(([l]) => l.startsWith('rolldown')),
  };
  for (const group of Object.values(byBundler)) {
    const [orig, native] = group;
    console.log(`${orig[0]}${ms(orig[1])}   1.00x`);
    console.log(`${native[0]}${ms(native[1])}   ${(orig[1] / native[1]).toFixed(2)}x`);
    console.log('');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
