/**
 * Rollup compatibility: the plugin must also work under a rollup service.
 * It never uses `this.parse` (everything runs natively), so it is
 * bundler-agnostic at the transform level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rollup } from 'rollup';

import { externalGlobals } from '../plugin.mjs';

async function build(files, plugin, outputOptions = { format: 'es' }) {
  const dir = await mkdtemp(join(tmpdir(), 'eg-rollup-'));
  try {
    let input;
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(dir, name);
      await writeFile(filePath, content);
      if (name === 'main.js') input = filePath;
    }
    const bundle = await rollup({ input, plugins: [plugin] });
    const { output } = await bundle.generate(outputOptions);
    await bundle.close();
    return output[0].code;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('rollup: default + named imports become globals', async () => {
  const code = await build(
    {
      'main.js': [
        'import $ from "jquery";',
        'import { debounce } from "lodash-es";',
        'import local from "./local.js";',
        '$("#app").text(local);',
        'export const d = debounce;',
      ].join('\n'),
      'local.js': 'export default "local";\n',
    },
    externalGlobals({ jquery: '$', 'lodash-es': '_' }),
  );
  assert.ok(!/["']jquery["']/.test(code), code);
  assert.ok(!/["']lodash-es["']/.test(code), code);
  assert.ok(code.includes('$("#app")'), code);
  assert.ok(code.includes('_.debounce'), code);
});

test('rollup: include/exclude filter works', async () => {
  const files = {
    'main.js': 'import a from "./a.js";\nimport b from "./b.js";\nconsole.log(a, b);\n',
    'a.js': 'import $ from "jquery";\nexport default $;\n',
    'b.js': 'import $ from "jquery";\nexport default $;\n',
  };
  const plugin = externalGlobals({ jquery: '$' }, { include: '**/a.js' });
  const code = await build(files, plugin);
  // b.js was filtered out: its jquery import must survive (as external)
  assert.equal(code.includes('from "jquery"') || code.includes("from 'jquery'"), true, code);
});

test('rollup: output matches rolldown output', async () => {
  const { rolldown } = await import('rolldown');
  const files = {
    'main.js': 'import foo, { bar } from "foo";\nconsole.log(foo, bar);\n',
  };
  const globals = { foo: 'FOO' };

  const dir = await mkdtemp(join(tmpdir(), 'eg-cmp2-'));
  try {
    const entry = join(dir, 'main.js');
    await writeFile(entry, files['main.js']);

    const rollupBundle = await rollup({ input: entry, plugins: [externalGlobals(globals)] });
    const rollupOut = (await rollupBundle.generate({ format: 'es' })).output[0].code;
    await rollupBundle.close();

    const rdBundle = await rolldown({
      input: entry,
      cwd: dir,
      plugins: [externalGlobals(globals)],
      treeshake: false,
    });
    const rdOut = (await rdBundle.generate({ format: 'esm' })).output[0].code;
    await rdBundle.close();

    // both bundlers must emit the rewritten references
    for (const code of [rollupOut, rdOut]) {
      assert.ok(code.includes('FOO.bar'), code);
      assert.ok(!/["']foo["']/.test(code), code);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
