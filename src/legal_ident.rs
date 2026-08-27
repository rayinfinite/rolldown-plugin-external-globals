//! Exact port of `makeLegalIdentifier` from `@rollup/pluginutils`, which the
//! original plugin uses to derive `_global_*` temp variable names.

use std::collections::HashSet;
use std::sync::LazyLock;

const RESERVED_WORDS: &str = "break case class catch const continue debugger default delete do \
  else export extends finally for function if import in instanceof let new return super switch \
  this throw try typeof var void while with yield enum await implements package protected static \
  interface private public";

const BUILTINS: &str = "arguments Infinity NaN undefined null true false eval uneval isFinite \
  isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI encodeURIComponent escape \
  unescape Object Function Boolean Symbol Error EvalError InternalError RangeError \
  ReferenceError SyntaxError TypeError URIError Number Math Date String RegExp Array Int8Array \
  Uint8Array Uint8ClampedArray Int16Array Int32Array Uint32Array Float32Array Float64Array Map \
  Set WeakMap WeakSet SIMD ArrayBuffer DataView JSON Promise Generator GeneratorFunction Reflect \
  Proxy Intl";

static FORBIDDEN: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
  RESERVED_WORDS.split(' ').chain(BUILTINS.split(' ')).chain(std::iter::once("")).collect()
});

pub fn make_legal_identifier(input: &str) -> String {
  // Step 1: `-(\w)` -> uppercased letter (JS `str.replace(/-(\w)/g, ...)`)
  let mut step1 = String::with_capacity(input.len());
  let mut chars = input.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '-' {
      let is_word = |ch: char| ch.is_ascii_alphanumeric() || ch == '_';
      if let Some(&next) = chars.peek() {
        if is_word(next) {
          chars.next();
          step1.push(next.to_ascii_uppercase());
          continue;
        }
      }
      step1.push('-');
    } else {
      step1.push(c);
    }
  }

  // Step 2: everything outside `[$_a-zA-Z0-9]` becomes `_`
  let mut identifier: String = step1
    .chars()
    .map(|c| if c == '$' || c == '_' || c.is_ascii_alphanumeric() { c } else { '_' })
    .collect();

  // Step 3: leading digit or forbidden identifier -> prefix `_`
  let starts_with_digit = identifier.chars().next().is_some_and(|c| c.is_ascii_digit());
  if starts_with_digit || FORBIDDEN.contains(identifier.as_str()) {
    identifier.insert(0, '_');
  }

  if identifier.is_empty() {
    identifier.push('_');
  }
  identifier
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn basic() {
    assert_eq!(make_legal_identifier("FOO"), "FOO");
    assert_eq!(make_legal_identifier("FOO.foo"), "FOO_foo");
    assert_eq!(make_legal_identifier("window.$"), "window_$");
    assert_eq!(make_legal_identifier("foo-bar"), "fooBar");
    assert_eq!(make_legal_identifier("9lives"), "_9lives");
    assert_eq!(make_legal_identifier("class"), "_class");
    assert_eq!(make_legal_identifier(""), "_");
    // Cross-checked against @rollup/pluginutils makeLegalIdentifier 5.4.0
    assert_eq!(make_legal_identifier("default"), "_default");
    assert_eq!(make_legal_identifier("a b c"), "a_b_c");
    assert_eq!(make_legal_identifier("window.$"), "window_$");
  }
}
