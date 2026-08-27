//! napi bindings for the native core of `rolldown-plugin-external-globals`.

mod legal_ident;
mod transform;

use std::collections::HashMap;

use napi_derive::napi;
use oxc_span::SourceType;
use transform::{TransformError, TransformOptions};

#[napi(object)]
pub struct JsDynamicReplacement {
  pub start: u32,
  pub end: u32,
  pub content: String,
}

#[napi(object)]
pub struct JsTransformOptions {
  /// Module id, used as the `source` of the generated sourcemap.
  pub id: String,
  /// module id -> global variable expression
  pub globals: HashMap<String, String>,
  /// Dynamic import wrapper template; `{id}` is replaced with the global
  /// expression. Defaults to `Promise.resolve({id})`.
  pub dynamic_wrapper_template: Option<String>,
  /// Precomputed dynamic-import replacements (used when the JS side passes a
  /// `dynamicWrapper` function, which cannot run natively).
  pub dynamic_replacements: Option<Vec<JsDynamicReplacement>>,
  pub const_bindings: Option<bool>,
  /// "js" | "jsx" | "ts" | "tsx"
  pub lang: Option<String>,
}

#[napi(object)]
pub struct JsTransformResult {
  pub code: String,
  pub map: Option<String>,
}

#[napi(object)]
pub struct JsDynamicImport {
  pub start: u32,
  pub end: u32,
  pub source: String,
}

#[napi(object)]
pub struct JsProbeResult {
  /// Every static module source referenced by imports/exports/dynamic imports.
  pub module_sources: Vec<String>,
  /// All `import("<literal>")` expressions.
  pub dynamic_imports: Vec<JsDynamicImport>,
}

fn source_type_from_lang(lang: Option<&str>) -> SourceType {
  match lang {
    Some("jsx") => SourceType::jsx(),
    Some("ts") => SourceType::ts(),
    Some("tsx") => SourceType::tsx(),
    _ => SourceType::mjs(),
  }
}

/// Transforms the module: removes imports of mapped modules and rewrites
/// references to the corresponding global variables.
///
/// Returns `null` when the module does not need to change.
#[napi]
pub fn transform_external_globals(
  code: String,
  options: JsTransformOptions,
) -> napi::Result<Option<JsTransformResult>> {
  let opts = TransformOptions {
    globals: options.globals,
    dynamic_wrapper_template: options.dynamic_wrapper_template,
    dynamic_replacements: options.dynamic_replacements.map(|list| {
      list.into_iter().map(|r| (r.start, r.end, r.content)).collect()
    }),
    const_bindings: options.const_bindings.unwrap_or(false),
    source_type: source_type_from_lang(options.lang.as_deref()),
  };
  match transform::transform_external_globals(&code, &options.id, &opts) {
    Ok(Some(output)) => Ok(Some(JsTransformResult { code: output.code, map: output.map_json })),
    Ok(None) => Ok(None),
    Err(TransformError::ExportAll) => Err(napi::Error::from_reason(
      "Cannot export all properties from an external variable",
    )),
    Err(TransformError::Edit(msg)) => Err(napi::Error::from_reason(msg)),
  }
}

/// Parses the module and reports every static import/export source plus all
/// static dynamic imports. Used by the JS wrapper when `globals` is a function
/// or `dynamicWrapper` is a function (both need decisions made in JS).
#[napi]
pub fn probe_module(code: String, lang: Option<String>) -> napi::Result<JsProbeResult> {
  match transform::probe_module(&code, source_type_from_lang(lang.as_deref())) {
    Some(probe) => Ok(JsProbeResult {
      module_sources: probe.module_sources,
      dynamic_imports: probe
        .dynamic_imports
        .into_iter()
        .map(|(start, end, source)| JsDynamicImport { start, end, source })
        .collect(),
    }),
    None => Ok(JsProbeResult { module_sources: vec![], dynamic_imports: vec![] }),
  }
}
