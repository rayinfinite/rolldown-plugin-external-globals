//! Core transformation: rewrite imports of "external globals" modules into
//! references of global variables.
//!
//! This is a Rust port of `rollup-plugin-external-globals`, implemented on top
//! of oxc (the parser Rolldown itself uses) instead of acorn + estree-walker.
//!
//! Behavioural parity goals (mirroring the original plugin):
//! - `import foo from "lib"` with `globals: { lib: "FOO" }` removes the import
//!   and rewrites every reference to `foo` into `FOO` (named imports become
//!   member expressions: `FOO.bar`).
//! - `export { x } from "lib"` becomes `var _global_FOO_x = FOO.x; export { _global_FOO_x as x };`.
//! - `export * from "lib"` throws ("Cannot export all properties from an external variable").
//! - Local declarations shadowing a global name are renamed to `_local_<name>`;
//!   when they were exported (`export const FOO = ...`) the `export` keyword is
//!   stripped and `export { _local_FOO as FOO };` is appended.
//! - `import("lib")` becomes `Promise.resolve(FOO)` (or the configured wrapper).
//! - References shadowed by inner scopes are left untouched (handled exactly by
//!   oxc's symbol resolution).

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::{
  AstKind,
  ast::{
    BindingIdentifier, Declaration, Expression, ImportDeclarationSpecifier, ImportExpression,
    ModuleExportName, Statement,
  },
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_semantic::{SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};
use string_wizard::{Hires, MagicString, SourceMapOptions};

use crate::legal_ident::make_legal_identifier;

#[derive(Debug)]
pub enum TransformError {
  /// `export * from "<mapped module>"` is not supported.
  ExportAll,
  /// An internal string-edit failed (should not happen on valid AST spans).
  Edit(String),
}

impl std::fmt::Display for TransformError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      TransformError::ExportAll => {
        write!(f, "Cannot export all properties from an external variable")
      }
      TransformError::Edit(msg) => write!(f, "internal edit error: {msg}"),
    }
  }
}

impl std::error::Error for TransformError {}

pub struct TransformOptions {
  /// module id -> global variable expression (e.g. `jquery` -> `$`).
  pub globals: HashMap<String, String>,
  /// Template used to replace dynamic imports. `{id}` is substituted with the
  /// global expression. `None` means the default `Promise.resolve({id})`.
  pub dynamic_wrapper_template: Option<String>,
  /// Precomputed dynamic-import replacements, used when the JS caller provides a
  /// `dynamicWrapper` function. Each entry is `(start, end, replacement)` and
  /// refers to the original source. When `Some`, template replacement is
  /// skipped entirely (an empty list means "replace nothing", which matters
  /// when the wrapper returns falsy for every import).
  pub dynamic_replacements: Option<Vec<(u32, u32, String)>>,
  /// Use `const` instead of `var` for generated `_global_*` bindings.
  pub const_bindings: bool,
  pub source_type: SourceType,
}

pub struct TransformOutput {
  pub code: String,
  pub map_json: Option<String>,
}

pub fn transform_external_globals(
  code: &str,
  id: &str,
  opts: &TransformOptions,
) -> Result<Option<TransformOutput>, TransformError> {
  // Fast skip: same as the original plugin, bail out early when none of the
  // module ids can possibly occur in the source.
  if !opts.globals.is_empty() && opts.globals.keys().all(|key| !code.contains(key.as_str())) {
    return Ok(None);
  }

  let allocator = Allocator::default();
  let parse_ret = Parser::new(&allocator, code, opts.source_type).parse();
  // The original plugin skips files it cannot parse.
  if parse_ret.panicked || !parse_ret.diagnostics.is_empty() {
    return Ok(None);
  }
  let program = parse_ret.program;

  // The full AST node store is required to map references back to spans;
  // it is disabled by default in oxc 0.147+.
  let semantic_ret = SemanticBuilder::new().with_build_nodes(true).build(&program);
  let (scoping, nodes) = semantic_ret.semantic.into_scoping_and_nodes();

  let mut ms = MagicString::new(code);
  let mut touched = false;
  // import binding symbol -> replacement expression
  let mut import_symbols: HashMap<SymbolId, String> = HashMap::new();
  // every global expression seen (used for local-name conflict detection)
  let mut global_names: HashSet<String> = HashSet::new();
  // `_global_*` temp names already declared
  let mut temp_names: HashSet<String> = HashSet::new();

  let top_stmt_spans: Vec<Span> = program.body.iter().map(oxc_span::GetSpan::span).collect();

  // ---------- dynamic imports: figure out which spans will be overwritten ----
  let mut scanner = DynImportScanner::default();
  scanner.visit_program(&program);

  let mut dyn_replace: Vec<(Span, Option<String>)> = Vec::new();
  if let Some(replacements) = &opts.dynamic_replacements {
    for (start, end, content) in replacements {
      dyn_replace.push((Span::new(*start, *end), Some(content.clone())));
    }
  } else {
    for (span, source) in &scanner.found {
      let Some(global_name) = opts.globals.get(source.as_str()) else { continue };
      let replacement = match &opts.dynamic_wrapper_template {
        Some(template) => template.replace("{id}", global_name),
        None => format!("Promise.resolve({global_name})"),
      };
      dyn_replace.push((*span, Some(replacement)));
    }
  }
  let dyn_spans: Vec<Span> = dyn_replace.iter().map(|(span, _)| *span).collect();
  let inside_replaced_dyn_import = |span: Span| -> bool {
    dyn_spans.iter().any(|s| span.start >= s.start && span.end <= s.end)
  };

  // ---------- pass 1: top-level import/export declarations ----------
  for stmt in &program.body {
    match stmt {
      Statement::ImportDeclaration(decl) => {
        let Some(global_name) = opts.globals.get(decl.source.value.as_str()) else {
          continue;
        };
        global_names.insert(global_name.clone());
        if let Some(specifiers) = &decl.specifiers {
          for spec in specifiers {
            // The original plugin treats every specifier without an `imported`
            // name as a "default" import (including namespace imports).
            let (prop, local): (String, &BindingIdentifier) = match spec {
              ImportDeclarationSpecifier::ImportSpecifier(s) => {
                let prop = match &s.imported {
                  ModuleExportName::IdentifierName(n) => n.name.to_string(),
                  ModuleExportName::StringLiteral(l) => l.value.to_string(),
                  ModuleExportName::IdentifierReference(r) => r.name.to_string(),
                };
                (prop, &s.local)
              }
              ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                ("default".to_string(), &s.local)
              }
              ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                ("default".to_string(), &s.local)
              }
            };
            let expr = make_global_name(&prop, global_name);
            if let Some(sid) = local.symbol_id.get() {
              import_symbols.insert(sid, expr);
            }
          }
        }
        ms.update(decl.span.start, decl.span.end, "").map_err(TransformError::Edit)?;
        touched = true;
      }
      // `export { x } from "lib"` (oxc 0.147+ models re-exports separately)
      Statement::ExportFromDeclaration(decl) => {
        let Some(global_name) = opts.globals.get(decl.source.value.as_str()) else {
          continue;
        };
        for spec in &decl.specifiers {
          let prop = match &spec.local {
            ModuleExportName::IdentifierName(n) => n.name.to_string(),
            ModuleExportName::StringLiteral(l) => l.value.to_string(),
            ModuleExportName::IdentifierReference(r) => r.name.to_string(),
          };
          let expr = make_global_name(&prop, global_name);
          write_spec_local(
            &mut ms,
            code,
            decl.span.start,
            spec.local.span(),
            spec.exported.span(),
            &expr,
            &mut temp_names,
            opts.const_bindings,
          )?;
        }
        if decl.specifiers.is_empty() {
          // `export {} from "lib"` -> removed entirely
          ms.update(decl.span.start, decl.span.end, "").map_err(TransformError::Edit)?;
        } else {
          let last_spec_end = decl.specifiers.last().unwrap().span.end;
          ms.update(last_spec_end, decl.source.span.end, "}").map_err(TransformError::Edit)?;
        }
        touched = true;
      }
      Statement::ExportAllDeclaration(decl) => {
        if opts.globals.contains_key(decl.source.value.as_str()) {
          return Err(TransformError::ExportAll);
        }
      }
      _ => {}
    }
  }

  // ---------- branch 1: rewrite references to removed import bindings ----------
  let import_symbol_ids: Vec<SymbolId> = import_symbols.keys().copied().collect();
  for sid in import_symbol_ids {
    let expr = import_symbols[&sid].clone();
    let ref_ids: Vec<_> = scoping.get_resolved_reference_ids(sid).to_vec();
    for rid in ref_ids {
      let node_id = scoping.get_reference(rid).node_id();
      let node = nodes.get_node(node_id);
      let span = node.kind().span();
      if inside_replaced_dyn_import(span) {
        continue;
      }
      match nodes.parent_kind(node_id) {
        // `export { foo }` cannot inline a member expression; hoist a temp.
        AstKind::ExportSpecifier(spec) => {
          let root = find_top_stmt(&top_stmt_spans, span.start).unwrap_or(spec.span);
          write_spec_local(
            &mut ms,
            code,
            root.start,
            spec.local.span(),
            spec.exported.span(),
            &expr,
            &mut temp_names,
            opts.const_bindings,
          )?;
        }
        // `{ foo }` shorthand -> `{ foo: FOO }`
        AstKind::ObjectProperty(prop) if prop.shorthand => {
          if span_text(code, span) != expr.as_str() {
            ms.append_left(span.end, format!(": {expr}")).map_err(TransformError::Edit)?;
          }
        }
        // `({ foo } = obj)` shorthand assignment target -> `({ foo: FOO } = obj)`
        AstKind::AssignmentTargetPropertyIdentifier(_) => {
          if span_text(code, span) != expr.as_str() {
            ms.append_left(span.end, format!(": {expr}")).map_err(TransformError::Edit)?;
          }
        }
        _ => {
          // The original plugin skips the edit when the replacement text is
          // identical to the identifier (`import FOO from "foo"`).
          if span_text(code, span) == expr.as_str() {
            continue;
          }
          ms.update(span.start, span.end, expr.clone()).map_err(TransformError::Edit)?;
        }
      }
    }
  }

  // ---------- branch 2: rename locals that shadow a global name ----------
  let shadow_symbols: Vec<SymbolId> = scoping
    .symbol_ids()
    .filter(|sid| {
      !import_symbols.contains_key(sid) && global_names.contains(scoping.symbol_name(*sid))
    })
    .collect();

  // Detect `export var/let/const FOO = ...` among the shadowed symbols.
  // Maps symbol -> (export statement span, inner declaration span).
  let mut export_lhs: HashMap<SymbolId, (Span, Span)> = HashMap::new();
  for stmt in &program.body {
    // `export var/let/const ...` (oxc 0.147+ models it as ExportDeclaration)
    let Statement::ExportDeclaration(decl) = stmt else { continue };
    let Declaration::VariableDeclaration(var_decl) = &decl.declaration else { continue };
    for declarator in &var_decl.declarations {
      let mut collector = BindingSymbolCollector::default();
      collector.visit_binding_pattern(&declarator.id);
      for decl_sid in collector.symbols {
        if shadow_symbols.contains(&decl_sid) {
          export_lhs.insert(decl_sid, (decl.span, var_decl.span));
        }
      }
    }
  }

  let mut stripped_exports: HashSet<u32> = HashSet::new();
  for sid in shadow_symbols {
    let name = scoping.symbol_name(sid).to_string();
    let new_name = format!("_local_{name}");

    // rename the declaration itself
    let decl_span = scoping.symbol_span(sid);
    if !inside_replaced_dyn_import(decl_span) {
      ms.update(decl_span.start, decl_span.end, new_name.clone()).map_err(TransformError::Edit)?;
    }
    for redecl in scoping.symbol_redeclarations(sid) {
      ms.update(redecl.span.start, redecl.span.end, new_name.clone())
        .map_err(TransformError::Edit)?;
    }

    // rename all references
    let ref_ids: Vec<_> = scoping.get_resolved_reference_ids(sid).to_vec();
    for rid in ref_ids {
      let node_id = scoping.get_reference(rid).node_id();
      let node = nodes.get_node(node_id);
      let span = node.kind().span();
      if inside_replaced_dyn_import(span) {
        continue;
      }
      match nodes.parent_kind(node_id) {
        AstKind::ObjectProperty(prop) if prop.shorthand => {
          ms.append_left(span.end, format!(": {new_name}")).map_err(TransformError::Edit)?;
        }
        AstKind::AssignmentTargetPropertyIdentifier(_) => {
          ms.append_left(span.end, format!(": {new_name}")).map_err(TransformError::Edit)?;
        }
        AstKind::ExportSpecifier(spec) => {
          if spec.local.span() == spec.exported.span() {
            ms.append_left(span.start, format!("{new_name} as ")).map_err(TransformError::Edit)?;
          } else {
            ms.update(span.start, span.end, new_name.clone()).map_err(TransformError::Edit)?;
          }
        }
        _ => {
          ms.update(span.start, span.end, new_name.clone()).map_err(TransformError::Edit)?;
        }
      }
    }

    // `export const FOO = ...` -> `const _local_FOO = ...; export { _local_FOO as FOO };`
    if let Some((stmt_span, inner_span)) = export_lhs.get(&sid) {
      if stripped_exports.insert(stmt_span.start) {
        ms.update(stmt_span.start, inner_span.start, "").map_err(TransformError::Edit)?;
      }
      ms.append_left(stmt_span.end, format!("export {{{new_name} as {name}}};\n"))
        .map_err(TransformError::Edit)?;
    }
  }

  // ---------- dynamic import replacement ----------
  for (span, replacement) in dyn_replace {
    if let Some(content) = replacement {
      ms.update(span.start, span.end, content).map_err(TransformError::Edit)?;
      touched = true;
    }
  }

  if !touched {
    return Ok(None);
  }

  let output_code = ms.to_string();
  let map = ms.source_map(SourceMapOptions {
    hires: Hires::Boundary,
    include_content: true,
    source: id.into(),
  });
  Ok(Some(TransformOutput { code: output_code, map_json: Some(map.to_json_string()) }))
}

pub struct ProbeOutput {
  pub module_sources: Vec<String>,
  /// `(start, end, source)` of every static dynamic import.
  pub dynamic_imports: Vec<(u32, u32, String)>,
}

/// Parses the module and collects every static module source (imports,
/// export-from, export-all, dynamic imports). The JS wrapper uses this to ask
/// user-provided `globals`/`dynamicWrapper` functions for decisions.
pub fn probe_module(code: &str, source_type: SourceType) -> Option<ProbeOutput> {
  let allocator = Allocator::default();
  let parse_ret = Parser::new(&allocator, code, source_type).parse();
  if parse_ret.panicked || !parse_ret.diagnostics.is_empty() {
    return None;
  }
  let program = parse_ret.program;

  let mut module_sources = Vec::new();
  for stmt in &program.body {
    match stmt {
      Statement::ImportDeclaration(decl) => {
        module_sources.push(decl.source.value.to_string());
      }
      Statement::ExportFromDeclaration(decl) => {
        module_sources.push(decl.source.value.to_string());
      }
      Statement::ExportAllDeclaration(decl) => {
        module_sources.push(decl.source.value.to_string());
      }
      _ => {}
    }
  }

  let mut scanner = DynImportScanner::default();
  scanner.visit_program(&program);
  for (_, source) in &scanner.found {
    module_sources.push(source.clone());
  }
  let dynamic_imports =
    scanner.found.into_iter().map(|(span, source)| (span.start, span.end, source)).collect();

  Some(ProbeOutput { module_sources, dynamic_imports })
}

/// `default` -> the global itself; named -> member access on the global.
fn make_global_name(prop: &str, name: &str) -> String {
  if prop == "default" {
    name.to_string()
  } else {
    format!("{name}.{prop}")
  }
}

fn span_text<'s>(code: &'s str, span: Span) -> &'s str {
  &code[span.start as usize..span.end as usize]
}

fn find_top_stmt(spans: &[Span], pos: u32) -> Option<Span> {
  spans.iter().copied().find(|s| s.start <= pos && pos <= s.end)
}

/// Mirrors `writeSpecLocal` of the original plugin: declare a `_global_*` temp
/// once, then point the export specifier's local at it.
#[allow(clippy::too_many_arguments)]
fn write_spec_local(
  ms: &mut MagicString,
  code: &str,
  root_start: u32,
  local_span: Span,
  exported_span: Span,
  expr: &str,
  temp_names: &mut HashSet<String>,
  const_bindings: bool,
) -> Result<(), TransformError> {
  let local_name = format!("_global_{}", make_legal_identifier(expr));
  if !temp_names.contains(&local_name) {
    let kw = if const_bindings { "const" } else { "var" };
    ms.append_right(root_start, format!("{kw} {local_name} = {expr};\n"))
      .map_err(TransformError::Edit)?;
    temp_names.insert(local_name.clone());
  }
  if span_text(code, local_span) == local_name {
    return Ok(());
  }
  if local_span == exported_span {
    ms.append_right(local_span.start, format!("{local_name} as ")).map_err(TransformError::Edit)?;
  } else {
    ms.update(local_span.start, local_span.end, local_name).map_err(TransformError::Edit)?;
  }
  Ok(())
}

/// Collects `import("...")` expressions with a static string source.
#[derive(Default)]
struct DynImportScanner {
  found: Vec<(Span, String)>,
}

impl<'a> Visit<'a> for DynImportScanner {
  fn visit_import_expression(&mut self, expr: &ImportExpression<'a>) {
    if let Expression::StringLiteral(lit) = &expr.source {
      self.found.push((expr.span, lit.value.to_string()));
    }
    walk::walk_import_expression(self, expr);
  }
}

/// Collects symbol ids of binding identifiers inside a pattern.
#[derive(Default)]
struct BindingSymbolCollector {
  symbols: Vec<SymbolId>,
}

impl<'a> Visit<'a> for BindingSymbolCollector {
  fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
    if let Some(sid) = it.symbol_id.get() {
      self.symbols.push(sid);
    }
  }
}
