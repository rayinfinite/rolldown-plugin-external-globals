# rolldown-plugin-external-globals

Rewrites imports of external modules into global variable references — a **Rust / [oxc](https://github.com/oxc-project/oxc) native rewrite** of [`rollup-plugin-external-globals`](https://github.com/eight04/rollup-plugin-external-globals), optimized for [Rolldown](https://rolldown.dev) and **fully compatible with Rollup** (the transform never uses `this.parse`, so it is bundler-agnostic).

[中文文档](./README.zh-CN.md)

```js
import jq from "jquery";
console.log(jq(".test"));
//  ↓ globals: { jquery: "$" }
console.log($(".test"));
```

## Why a rewrite

The original plugin is slow under Rolldown because it goes through **rollup's AST path**:

| Step | Original plugin (JS) | This plugin (Rust) |
| --- | --- | --- |
| Parsing | `this.parse` → deserialized into a JS ESTree object tree | oxc parsing (Rolldown's own parser), no JS object materialization |
| Scopes | `attachScopes` builds a hand-rolled JS scope chain | `Semantic` resolves symbols/scopes/references in one pass |
| Traversal | `estree-walker` walks every node in JS | no full-tree walk — references are located directly per symbol |
| Re-parsing | returns `code` only; the bundler parses the result again | also returns `code` + `map`, but the rewrite itself costs zero JS work |

Measured (`npm run bench`, 200 modules × ~120 references); output is **byte-identical** to the original plugin:

| Scenario | Original | Native | Speedup |
| --- | --- | --- | --- |
| `transform` only (plugin cost isolated) | 64.7ms | 14.1ms | **4.6x** |
| rollup full build | 216.1ms | 176.7ms | 1.22x |
| rolldown full build | 116.5ms | 34.9ms | **3.33x** |

> The rollup full-build speedup is smaller because rollup's own parse/tree-shaking/render dominates; the isolated plugin cost (first row) is the comparable metric.

### Real-world comparisons

**ant-design v6** (`npm run bench:antd`; corpus preparation in the header of `test/bench-antd.mjs`):

| Setup | Time | Notes |
| --- | --- | --- |
| rolldown + original plugin | 302ms | only works on esbuild-precompiled JS |
| rolldown + this plugin | 143ms | **2.11x**, byte-identical output (3.0 MiB) |

Corpus = all antd components (650 modules) + the `@rc-component/*` dependency tree (811 modules): 1461 modules transformed.

**MUI v9 (material + icons, prebuilt ESM from npm)** (`npm run bench:mui`):

| Setup | Time | Notes |
| --- | --- | --- |
| no-plugin baseline | 387ms | rolldown core overhead (11648 modules) |
| rolldown + original plugin | 996ms | plugin adds ~609ms |
| rolldown + this plugin | 643ms | plugin adds ~256ms — **2.4x on plugin overhead**, byte-identical output (7.1 MiB) |

> The larger the module count, the more rolldown's fixed overhead dilutes the whole-build ratio; plugin overhead (total − baseline) is the comparable metric.

**An even more important capability gap**: the original plugin relies on `this.parse` (a JS parser), but rolldown hands plugin transforms the source **before TS is stripped** — `this.parse` throws on any file containing `:` type annotations or JSX, and the plugin silently skips it. In other words, **the original plugin cannot transform any TS/TSX file under rolldown** (for a project like antd that means 0 files transformed, silently producing wrong output). This plugin parses TS/TSX natively with oxc and handles all of them (see `test/tsx-probe.mjs`).

## Installation

```bash
npm i -D rolldown-plugin-external-globals
# building from source:
npm run build        # napi build --platform --release --esm
```

## Usage

```js
// rolldown.config.mjs
import { defineConfig } from "rolldown";
import { externalGlobals } from "rolldown-plugin-external-globals";

export default defineConfig({
  input: "src/main.js",
  plugins: [
    externalGlobals({
      jquery: "$",
      react: "React",
      "lodash-es": "_",
    }),
  ],
});
```

### Options

```js
externalGlobals(globals, {
  include,          // string | RegExp | Array — only transform matching files
  exclude,          // string | RegExp | Array — skip matching files
  dynamicWrapper,   // (name) => string | false, or a template string "Promise.resolve({id})"
  constBindings,    // declare generated _global_* bindings with const instead of var
})
```

- `globals`: a `{ moduleId: globalName }` object, or a `(id) => globalName` function.
- `include` / `exclude`: same semantics as the original plugin (`createFilter` from `@rollup/pluginutils`, picomatch semantics). `\0` virtual modules are always transformed.
- `dynamicWrapper`: defaults to `Promise.resolve({id})`. Returning `false`/falsy keeps that dynamic `import()` untouched.
- `constBindings`: defaults to `false`.

### Using it in a Rollup project

The transform **does not rely on `this.parse`** (parsing, scope analysis and rewriting all happen in Rust), so the plugin is bundler-agnostic and works directly in a rollup setup:

```js
// rollup.config.mjs
import { externalGlobals } from "rolldown-plugin-external-globals";

export default {
  input: "src/main.js",
  plugins: [externalGlobals({ jquery: "$" })],
};
```

The API and options match `rollup-plugin-external-globals` (`resolveId` marks modules external, `transform` returns `{code, map}`). Note: as with the original plugin, put it early in the plugin list so its `resolveId` runs before other resolver plugins.

## Behavior (aligned with the original plugin)

- `import foo from "lib"` → the import is removed and references to `foo` are replaced with the global name; named imports become member access `GLOBAL.prop`.
- Variables shadowing a global name in inner scopes are never replaced (decided by exact symbol resolution, not text matching).
- Local declarations conflicting with a global name are renamed to `_local_<name>`; if such a declaration was `export`ed, the `export` keyword is stripped and `export {_local_<name> as <name>};` is appended.
- `export { x } from "lib"` → `var _global_<legal> = <expr>; export { _global_<legal> as x };`.
- `export * from "lib"` → throws `Cannot export all properties from an external variable` (same as the original).
- Returns `code`/`map` only; does not change module type; sourcemaps are generated with `string_wizard`.

## Development

```bash
npm install
npm run build         # compile the native module (ESM)
npm test              # parity tests + rolldown/rollup end-to-end (40 cases)
npm run bench         # 2x2 perf matrix (rollup/rolldown × original/native) + transform micro-bench
cargo test            # Rust unit tests
```

Test strategy: `test/parity.test.mjs` runs the original plugin and the native implementation on **identical inputs** and compares byte-for-byte; `test/e2e.test.mjs` / `test/rollup.test.mjs` run real `rolldown` / `rollup` builds.

## License

MIT (same as the original plugin).
