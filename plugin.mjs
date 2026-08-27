import { createFilter } from '@rollup/pluginutils';

import { probeModule, transformExternalGlobals } from './index.js';

const toArray = (value) => (Array.isArray(value) ? value : [value]);

/**
 * Create the plugin. Works with both Rolldown and Rollup: the transform runs
 * entirely in Rust (oxc), so the plugin does not rely on bundler-provided
 * parsing (`this.parse`) at all.
 *
 * @param {Record<string, string> | ((id: string) => string | undefined)} globals
 *   Map of module id -> global variable expression, or a function returning
 *   the global variable name for a module id.
 * @param {object} [options]
 * @param {string | RegExp | Array<string | RegExp>} [options.include]
 * @param {string | RegExp | Array<string | RegExp>} [options.exclude]
 * @param {((name: string) => string | false) | string} [options.dynamicWrapper]
 *   Wrapper for dynamic imports. A function receives the global expression;
 *   a string is used as a template where `{id}` is replaced with the global
 *   expression. Defaults to `Promise.resolve({id})`.
 * @param {boolean} [options.constBindings]
 *   Use `const` instead of `var` for the generated `_global_*` bindings.
 */
export function externalGlobals(
  globals,
  { include, exclude, dynamicWrapper, constBindings = false } = {},
) {
  if (!globals) {
    throw new TypeError("Missing mandatory option 'globals'");
  }
  const globalsType = typeof globals;
  const isGlobalsObj = globalsType === 'object';
  if (!isGlobalsObj && globalsType !== 'function') {
    throw new TypeError(`Unexpected type of 'globals', got '${globalsType}'`);
  }
  if (
    dynamicWrapper != null &&
    typeof dynamicWrapper !== 'function' &&
    typeof dynamicWrapper !== 'string'
  ) {
    throw new TypeError(`Unexpected type of 'dynamicWrapper', got '${typeof dynamicWrapper}'`);
  }

  const getName = isGlobalsObj
    ? (id) => (Object.prototype.hasOwnProperty.call(globals, id) ? globals[id] : undefined)
    : globals;

  // Same filter semantics as the original plugin. Virtual modules (\0...) are
  // always transformed.
  const filter = createFilter(include, exclude);
  const shouldTransform = (id) => id.startsWith('\0') || filter(id);

  const langOf = (id) => {
    if (/\.(tsx|jsx)$/.test(id)) return id.endsWith('.tsx') ? 'tsx' : 'jsx';
    if (/\.(ts|mts|cts)$/.test(id)) return 'ts';
    return undefined;
  };

  const transform = function transform(code, id) {
    if (!shouldTransform(id)) return null;

    const lang = langOf(id);
    let globalsMap;
    let dynamicReplacements;
    const fnWrapper = typeof dynamicWrapper === 'function';

    if (isGlobalsObj && !fnWrapper) {
      // Fast path: everything is decidable natively.
      globalsMap = globals;
    } else {
      // Slow path: `globals` and/or `dynamicWrapper` are JS functions. Probe
      // the module once in Rust, decide in JS, then run the native transform.
      const probe = probeModule(code, lang);
      if (isGlobalsObj) {
        globalsMap = globals;
      } else {
        globalsMap = {};
        for (const source of new Set(probe.moduleSources)) {
          const name = getName(source);
          if (name) globalsMap[source] = name;
        }
      }
      if (fnWrapper) {
        dynamicReplacements = [];
        for (const di of probe.dynamicImports) {
          const globalName = globalsMap[di.source];
          if (!globalName) continue;
          const replacement = dynamicWrapper(globalName);
          if (replacement) {
            dynamicReplacements.push({ start: di.start, end: di.end, content: String(replacement) });
          }
        }
      }
      if (
        Object.keys(globalsMap).length === 0 &&
        (dynamicReplacements === undefined || dynamicReplacements.length === 0)
      ) {
        return null;
      }
    }

    const result = transformExternalGlobals(code, {
      id,
      globals: globalsMap,
      dynamicWrapperTemplate: typeof dynamicWrapper === 'string' ? dynamicWrapper : undefined,
      dynamicReplacements,
      constBindings,
      lang,
    });
    if (!result) return null;
    return {
      code: result.code,
      map: result.map ? JSON.parse(result.map) : null,
    };
  };

  return {
    name: 'external-globals',
    // Keep entries and virtual modules untouched (matches the original
    // plugin's resolver); mark everything mapped as external.
    resolveId(importee, _importer, options) {
      if (importee.startsWith('\0') || options?.isEntry) return null;
      const name = getName(importee);
      return name ? { id: importee, external: true } : null;
    },
    transform,
  };
}

export default externalGlobals;
