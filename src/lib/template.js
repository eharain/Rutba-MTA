'use strict';

/**
 * Tiny mustache-style {{key}} substitution. Pure — tested in test/template.test.mjs.
 *
 * - Supports {{key}} and {{ nested.key }} (dot path lookup against the data object).
 * - Unknown keys render as empty string.
 * - Triple-brace {{{key}}} bypasses HTML escaping (use sparingly — only when
 *   the value is already known-safe HTML, e.g. an injected action URL).
 * - Whitespace inside the braces is tolerated: {{ name }} === {{name}}.
 *
 * The mailer performs SUBSTITUTION only — callers must sanitise user-supplied
 * data before passing it. Double-brace output is HTML-escaped to prevent the
 * obvious case where a stray '<' breaks the email body, but this is not a
 * full XSS layer.
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(data, dottedKey) {
  if (data == null) return '';
  const parts = dottedKey.split('.');
  let cur = data;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[p];
  }
  if (cur == null) return '';
  return cur;
}

function render(template, data) {
  if (template == null) return '';
  const src = String(template);
  // Triple-brace first (so we don't double-process). Then double-brace.
  return src
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => String(lookup(data, key) ?? ''))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeHtml(lookup(data, key)));
}

/** Convenience: render an object of templates against the same data. */
function renderAll(templates, data) {
  const out = {};
  for (const k of Object.keys(templates || {})) out[k] = render(templates[k], data);
  return out;
}

module.exports = { render, renderAll, escapeHtml };
