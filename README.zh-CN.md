# rolldown-plugin-external-globals

把外部模块的 `import` 重写成全局变量引用——即 [`rollup-plugin-external-globals`](https://github.com/eight04/rollup-plugin-external-globals) 的 **Rust / [oxc](https://github.com/oxc-project/oxc) 原生重写版**，为 [Rolldown](https://rolldown.dev) 优化，同时**完全兼容 Rollup**（转换不依赖 `this.parse`，bundler 无关）。

```js
import jq from "jquery";
console.log(jq(".test"));
//  ↓ globals: { jquery: "$" }
console.log($(".test"));
```

## 为什么要重写

原插件在 Rolldown 下慢，根因是它走 **rollup 的 AST 路径**：

| 环节 | 原插件（JS） | 本插件（Rust） |
| --- | --- | --- |
| 解析 | `this.parse` → 反序列化成 JS ESTree 对象树 | oxc 解析（Rolldown 同款），不物化 JS 对象 |
| 作用域 | `attachScopes` 手写 JS 作用域链 | `Semantic` 一遍出符号/作用域/引用解析 |
| 遍历 | `estree-walker` 逐节点 JS 遍历 | 无全树遍历，直接按符号定位引用 |
| 二次解析 | 只返回 `code`，bundler 还要再解析一遍 | 同样返回 `code`+`map`，但改写本身零 JS 开销 |

实测（200 模块 × ~120 个引用，`npm run bench`），产物与原插件**逐字节一致**：

| 场景 | 原插件 | 本插件 | 提速 |
| --- | --- | --- | --- |
| 纯 `transform`（隔离插件开销） | 64.7ms | 14.1ms | **4.6x** |
| rollup 整包构建 | 216.1ms | 176.7ms | 1.22x |
| rolldown 整包构建 | 116.5ms | 34.9ms | **3.33x** |

> rollup 整包构建提速较小，是因为 rollup 自身的解析/tree-shaking/render 占了大头；插件自身开销（第一行）才是可比口径。

### 真实项目对比

**ant-design v6**（`npm run bench:antd`，语料准备见 `test/bench-antd.mjs` 头注）：

| 组合 | 耗时 | 说明 |
| --- | --- | --- |
| rolldown + 原插件 | 302ms | 仅对 esbuild 预编译后的 JS 有效 |
| rolldown + 本插件 | 143ms | **2.11x**，产物与原插件**逐字节一致**（3.0 MiB） |

语料 = antd 全部组件（650 模块）+ `@rc-component/*` 依赖树（811 模块），共 1461 个模块参与 transform。

**MUI v9（material + icons，npm 预编译 ESM）**（`npm run bench:mui`）：

| 组合 | 耗时 | 说明 |
| --- | --- | --- |
| 无插件基线 | 387ms | rolldown 核心自身开销（11648 模块） |
| rolldown + 原插件 | 996ms | 插件附加 ~609ms |
| rolldown + 本插件 | 643ms | 插件附加 ~256ms，**插件开销 2.4x**，产物逐字节一致（7.1 MiB） |

> 模块数越大，rolldown 核心的固定开销占比越高，整包倍数会被稀释；插件自身开销（总耗时 − 基线）才是插件的可比口径。

**更重要的能力差异**：原插件依赖 `this.parse`（JS 解析器），而 rolldown 的插件 transform 收到的是**未经 TS 剥离的源码**——`this.parse` 对任何含 `:` 类型标注或 JSX 的文件直接抛错，插件静默跳过。也就是说**原插件在 rolldown 下无法转换任何 TS/TSX 文件**（antd 这类项目 = 0 个文件被转换，产物悄悄出错）；本插件用 oxc 原生解析 TS/TSX，全部正确处理（见 `test/tsx-probe.mjs`）。

## 安装

```bash
npm i -D rolldown-plugin-external-globals
# 本仓库从源码构建：
npm run build        # napi build --platform --release --esm
```

## 用法

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

### 选项

```js
externalGlobals(globals, {
  include,          // string | RegExp | Array，只转换匹配的文件
  exclude,          // string | RegExp | Array，跳过匹配的文件
  dynamicWrapper,   // (name) => string | false，或模板字符串 "Promise.resolve({id})"
  constBindings,    // true 时用 const 而非 var 声明 _global_* 绑定
})
```

- `globals`：`{ moduleId: globalName }` 对象，或 `(id) => globalName` 函数。
- `include` / `exclude`：与原插件一致（`@rollup/pluginutils` 的 `createFilter`，picomatch 语义）。`\0` 虚拟模块始终转换。
- `dynamicWrapper`：默认 `Promise.resolve({id})`。返回 `false`/空则保留该动态 `import()`。
- `constBindings`：默认 `false`。

### 在 Rollup 项目里用

本插件转换时**不依赖 `this.parse`**（解析、作用域、改写全在 Rust 完成），因此是 bundler 无关的，同样可以直接用在 rollup 服务里：

```js
// rollup.config.mjs
import { externalGlobals } from "rolldown-plugin-external-globals";

export default {
  input: "src/main.js",
  plugins: [externalGlobals({ jquery: "$" })],
};
```

API 与选项和 `rollup-plugin-external-globals` 一致（`resolveId` 标记 external、`transform` 返回 `{code, map}`）。注意：和原插件一样，建议把它放在插件列表靠前位置，确保 `resolveId` 先于其他解析类插件执行。

## 行为说明（与原插件对齐）

- `import foo from "lib"` → 删除 import，把对 `foo` 的引用替换成全局名；命名导入变成员访问 `GLOBAL.prop`。
- 局部作用域内同名变量会遮蔽全局名，不会被替换（按符号解析精确判断，不靠文本匹配）。
- 与全局名冲突的局部声明会被改名为 `_local_<name>`；若它被 `export`，会剥离 `export` 关键字并追加 `export {_local_<name> as <name>};`。
- `export { x } from "lib"` → `var _global_<legal> = <expr>; export { _global_<legal> as x };`。
- `export * from "lib"` → 抛出 `Cannot export all properties from an external variable`（与原插件一致）。
- 只返回 `code`/`map`，不改 `module type`，sourcemap 用 `string_wizard` 生成。

## 开发

```bash
npm install
npm run build         # 编译原生模块（ESM）
npm test              # 对齐测试 + rolldown/rollup 端到端（40 项）
npm run bench         # 2x2 性能对比（rollup/rolldown × 原插件/本插件）+ 纯 transform 微基准
cargo test            # Rust 单元测试
```

测试策略：`test/parity.test.mjs` 把原插件与原生实现跑在**相同输入**上逐字节比对；`test/e2e.test.mjs` / `test/rollup.test.mjs` 分别走真实 `rolldown` / `rollup` 构建。


### 测试结果（最近一次运行，全部通过）

| 套件 | 用例数 | 结果 |
| --- | --- | --- |
| 与原插件逐字节对齐 | 31 | 31 通过 |
| rolldown 端到端 | 6 | 6 通过 |
| rollup 端到端 | 3 | 3 通过 |
| **合计（JS）** | **40** | **40 通过，0 失败** |
| Rust 单测（`cargo test`） | — | 通过 |


### 性能对比（产物逐字节一致）

| 语料 | 规模 | 原插件 | 原生插件 | 提速 |
| --- | --- | --- | --- | --- |
| 纯 `transform` | 200 模块 | 64.7ms | 14.1ms | **4.6x** |
| rollup 整包构建 | 200 模块 | 216.1ms | 176.7ms | 1.22x |
| rolldown 整包构建 | 200 模块 | 116.5ms | 34.9ms | **3.33x** |
| ant-design v6（rolldown 构建） | 1461 模块 | 302ms | 143ms | **2.11x** |
| MUI v9（rolldown 构建） | 11648 模块 | 996ms | 643ms | 整包 1.55x，**插件开销口径 2.4x** |

复现：`npm run bench`、`npm run bench:antd`、`npm run bench:mui`；方法与说明见上文「为什么要重写」与「真实项目对比」两节。

## 许可证

MIT（与原插件一致）。
