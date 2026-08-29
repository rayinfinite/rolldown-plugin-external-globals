/**
 * End-to-end tests: run real rolldown builds through the plugin and assert on
 * the generated output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rolldown } from 'rolldown';

import { externalGlobals } from '../plugin.mjs';

async function build(files, plugin, outputOptions = { format: 'esm' }) {
  const dir = await mkdtemp(join(tmpdir(), 'eg-e2e-'));
  try {
    let input;
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(dir, name);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content);
      if (name === 'main.js') input = filePath;
    }
    const bundle = await rolldown({
      input,
      cwd: dir,
      plugins: [plugin],
      // keep the output readable for assertions
      treeshake: false,
    });
    const { output } = await bundle.generate(outputOptions);
    await bundle.close();
    return output[0].code;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('e2e: default + named imports become globals', async () => {
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
  assert.ok(!/["']jquery["']/.test(code), `jquery import should be gone:\n${code}`);
  assert.ok(!/["']lodash-es["']/.test(code), `lodash-es import should be gone:\n${code}`);
  assert.ok(code.includes('$("#app")'), code);
  assert.ok(code.includes('_.debounce'), code);
  assert.ok(code.includes('"local"') || code.includes("'local'"), 'local module must stay bundled: ' + code);
});

test('e2e: local variable shadowing the global is renamed', async () => {
  const code = await build(
    {
      'main.js': [
        'import { useState } from "react";',
        'const React = { fake: true };',
        'console.log(useState, React);',
        'export { React };',
      ].join('\n'),
    },
    externalGlobals({ react: 'React' }),
  );
  assert.ok(code.includes('React.useState'), code);
  assert.ok(code.includes('_local_React'), code);
  assert.ok(code.includes('_local_React as React'), code);
});

test('e2e: dynamic import uses the wrapper', async () => {
  const code = await build(
    {
      'main.js': 'export const p = import("jquery").then((m) => m);\n',
    },
    externalGlobals({ jquery: '$' }),
  );
  assert.ok(!/["']jquery["']/.test(code), code);
  assert.ok(code.includes('Promise.resolve($)'), code);
});

test('e2e: export-from is hoisted into _global_* bindings', async () => {
  const code = await build(
    {
      'main.js': 'export { debounce } from "lodash-es";\n',
    },
    externalGlobals({ 'lodash-es': '_' }),
  );
  assert.ok(code.includes('_global___debounce') || code.includes('_global_$__debounce') || /var _global_\w+ = _\.debounce/.test(code), code);
  assert.ok(/export \{ _global_\w+ as debounce \}/.test(code), code);
});

test('e2e: include/exclude filter (createFilter)', async () => {
  const files = {
    'main.js': 'import a from "./a.js";\nimport b from "./b.js";\nconsole.log(a, b);\n',
    'a.js': 'import $ from "jquery";\nexport default $;\n',
    'b.js': 'import $ from "jquery";\nexport default $;\n',
  };
  // only transform a.js -> b.js keeps its jquery import (externalized via resolveId)
  const plugin = externalGlobals({ jquery: '$' }, { include: '**/a.js' });
  const code = await build(files, plugin);
  // b.js was not transformed: its jquery import must still be there
  assert.equal(code.includes('from "jquery"') || code.includes("from 'jquery'"), true, code);
  // a.js was transformed: `$` is used directly somewhere
  assert.ok(/\$\b/.test(code), code);
});

test('e2e: sourcemap is produced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eg-e2e-'));
  try {
    const entry = join(dir, 'main.js');
    await writeFile(entry, 'import $ from "jquery";\n$("#x");\n');
    const bundle = await rolldown({
      input: entry,
      cwd: dir,
      plugins: [externalGlobals({ jquery: '$' })],
      treeshake: false,
    });
    const { output } = await bundle.generate({ format: 'esm', sourcemap: true });
    await bundle.close();
    assert.ok(output[0].map, 'a sourcemap should be generated');
    assert.ok(output[0].code.includes('$("#x")'), output[0].code);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
