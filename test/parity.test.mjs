/**
 * Parity tests: run the original `rollup-plugin-external-globals` transform
 * and our native transform on identical inputs, then compare byte-for-byte.
 *
 * The original plugin's transform is invoked directly (not through a bundler)
 * with a minimal PluginContext providing `parse` (rollup's own parser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAst } from 'rollup/parseAst';
import originalPlugin from 'rollup-plugin-external-globals';

import { transformExternalGlobals } from '../index.js';
import { externalGlobals } from '../plugin.mjs';

const ID = '/project/entry.js';

async function runOriginal(code, globals, options) {
  const plugin = originalPlugin(globals, options);
  const ctx = { parse: parseAst, warn() {}, debug() {} };
  const result = await plugin.transform.call(ctx, code, ID);
  return result == null ? null : result.code;
}

function runNative(code, globals, options = {}) {
  const result = transformExternalGlobals(code, {
    id: ID,
    globals,
    constBindings: options.constBindings ?? false,
    dynamicWrapperTemplate: options.dynamicWrapperTemplate,
    dynamicReplacements: options.dynamicReplacements,
  });
  return result == null ? null : result.code;
}

/** Compare original vs native on the same input. */
async function expectParity(name, code, globals, options = {}) {
  const expected = await runOriginal(code, globals, options);
  const actual = runNative(code, globals, options);
  assert.equal(actual, expected, `${name}: native output differs from the original plugin`);
}

const CASES = [
  ['default', 'import foo from "foo";\nconsole.log(foo);\n', { foo: 'FOO' }],
  ['default no rewrite', 'import FOO from "foo";\nconsole.log(FOO);\n', { foo: 'FOO' }],
  ['named', 'import {bar} from "foo";\nconsole.log(bar);\n', { foo: 'FOO' }],
  ['named rename', 'import {bar as baz} from "foo";\nconsole.log(baz);\n', { foo: 'FOO' }],
  ['multiple named', 'import {a, b as c} from "foo";\nconsole.log(a, c);\n', { foo: 'FOO' }],
  ['object shorthand', 'import foo from "foo";\nconsole.log({foo});\n', { foo: 'FOO' }],
  [
    'scoped variable',
    'import foo from "foo";\n{\n  console.log(foo);\n}\n{\n  const foo = "foo";\n  console.log(foo);\n}\n',
    { foo: 'FOO' },
  ],
  ['conflict', 'import foo from "foo";\nconst FOO = 123;\nconsole.log(foo, FOO);\n', { foo: 'FOO' }],
  [
    'conflict exported',
    'import foo from "foo";\nexport const FOO = 123;\nconsole.log(foo, FOO);\n',
    { foo: 'FOO' },
  ],
  [
    'conflict exported 2',
    'import foo from "foo";\nconst FOO = 123;\nexport {FOO};\nconsole.log(foo, FOO);\n',
    { foo: 'FOO' },
  ],
  [
    'do not touch unused',
    'import foo from "foo";\nimport bar from "bar";\nconsole.log(foo, bar);\n',
    { foo: 'FOO' },
  ],
  ['dynamic import', 'import("foo")\n  .then(console.log);\n', { foo: 'FOO' }],
  [
    'export from name',
    'export {foo as bar} from "foo";\nexport {mud} from "mud";\n',
    { foo: 'FOO', mud: 'MUD' },
  ],
  [
    'export from duplicated',
    'export {foo as bar} from "foo";\nexport {foo as baz} from "foo";\n',
    { foo: 'FOO' },
  ],
  [
    'export from default',
    'export {default as baz} from "bak";\nexport {default as BOO} from "boo";\n',
    { bak: 'BAK', boo: 'BOO' },
  ],
  ['export from empty', 'export {} from "foo";\n', { foo: 'FOO' }],
  ['export from others', 'export {foo} from "bar";\n', { foo: 'FOO' }],
  ['need extra assignment', 'import foo from "foo";\n\nexport {foo};\n', { foo: 'FOO' }],
  ['constBindings', 'import foo from "foo";\n\nexport {foo};\n', { foo: 'FOO' }, { constBindings: true }],
  [
    'no duplicated assignment',
    'import foo from "foo";\n\nexport {foo};\nexport {foo as bar};\n',
    { foo: 'FOO' },
  ],
  [
    'do not affect normal references',
    'import foo from "foo";\nconsole.log(foo);\nexport {foo};\n',
    { foo: 'FOO' },
  ],
  [
    'work in exported function',
    'import * as _require_promise_ from "promise";\nexport default function () {\n  return _require_promise_;\n}\n',
    { promise: 'Promise' },
  ],
  [
    'assignment target shorthand',
    'import foo from "foo";\nlet obj = {};\n({foo} = obj);\n',
    { foo: 'FOO' },
  ],
  ['untouched module', 'const a = 1;\nconsole.log(a);\n', { foo: 'FOO' }],
  [
    'member global',
    'import foo from "foo";\nconsole.log(foo);\n',
    { foo: 'window.FOO' },
  ],
  [
    'redeclare var after import',
    'import foo from "foo";\nconsole.log(foo);\nfunction x() { var foo = 1; return foo; }\n',
    { foo: 'FOO' },
  ],
];

for (const [name, code, globals, options = {}] of CASES) {
  test(`parity: ${name}`, () => expectParity(name, code, globals, options));
}

test('parity: custom dynamicWrapper (function vs template)', async () => {
  const code = 'import("foo")\n  .then(console.log);\n';
  const globals = { foo: 'FOO' };
  const expected = await runOriginal(code, globals, {
    dynamicWrapper: (name) => `Promise.all([${name}, BAR])`,
  });
  const actual = runNative(code, globals, { dynamicWrapperTemplate: 'Promise.all([{id}, BAR])' });
  assert.equal(actual, expected);
});

test('parity: falsy dynamicWrapper keeps import', async () => {
  const code = 'import bar from "foo";\nconsole.log(bar);\nimport("foo")\n  .then(console.log);\n';
  const globals = { foo: 'FOO' };
  const expected = await runOriginal(code, globals, { dynamicWrapper: () => false });
  // Native equivalent of a falsy wrapper: an explicit empty replacement list.
  const actual = runNative(code, globals, { dynamicReplacements: [] });
  assert.equal(actual, expected);
});

test('parity: export all throws', async () => {
  const code = 'export * from "foo";\n';
  const globals = { foo: 'FOO' };
  await assert.rejects(() => runOriginal(code, globals), /Cannot export all/);
  assert.throws(() => runNative(code, globals), /Cannot export all/);
});

test('plugin wrapper: function globals + function dynamicWrapper', async () => {
  const code = 'import bar from "foo";\nconsole.log(bar);\nimport("foo").then(console.log);\n';
  const plugin = externalGlobals(
    (id) => (id === 'foo' ? 'FOO' : undefined),
    { dynamicWrapper: (name) => `Promise.all([${name}, BAR])` },
  );
  const handler = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
  const result = await handler.call({}, code, ID);
  const expected = await runOriginal(code, (id) => (id === 'foo' ? 'FOO' : undefined), {
    dynamicWrapper: (name) => `Promise.all([${name}, BAR])`,
  });
  assert.equal(result.code, expected);
});

test('plugin wrapper: resolveId marks mapped ids external', () => {
  const plugin = externalGlobals({ jquery: '$' });
  assert.deepEqual(plugin.resolveId('jquery', ID, {}), { id: 'jquery', external: true });
  assert.equal(plugin.resolveId('other', ID, {}), null);
  assert.equal(plugin.resolveId('\0virtual', ID, {}), null);
  assert.equal(plugin.resolveId('jquery', ID, { isEntry: true }), null);
});
