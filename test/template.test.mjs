import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { render, renderAll, escapeHtml } = require('../src/lib/template.js');

test('substitutes {{key}}', () => {
  assert.equal(render('Hi {{name}}!', { name: 'Ada' }), 'Hi Ada!');
});

test('tolerates whitespace inside braces', () => {
  assert.equal(render('{{ name }} {{age}}', { name: 'A', age: 9 }), 'A 9');
});

test('unknown keys render as empty', () => {
  assert.equal(render('Hi {{missing}}!', {}), 'Hi !');
  assert.equal(render('Hi {{name}}!', null), 'Hi !');
});

test('dot path lookup', () => {
  assert.equal(render('{{user.name}}', { user: { name: 'X' } }), 'X');
  assert.equal(render('{{a.b.c}}', { a: { b: { c: 7 } } }), '7');
  assert.equal(render('{{a.b.c}}', { a: { b: null } }), '');
});

test('double-brace HTML-escapes', () => {
  assert.equal(render('{{x}}', { x: '<script>' }), '&lt;script&gt;');
  assert.equal(render('{{x}}', { x: `&"'<>` }), '&amp;&quot;&#39;&lt;&gt;');
});

test('triple-brace bypasses escaping (for trusted action URLs)', () => {
  assert.equal(render('{{{u}}}', { u: '<a href="x">go</a>' }), '<a href="x">go</a>');
});

test('renderAll batches a map of templates', () => {
  const out = renderAll({ a: 'Hi {{n}}', b: 'Bye {{n}}' }, { n: 'X' });
  assert.deepEqual(out, { a: 'Hi X', b: 'Bye X' });
});

test('escapeHtml is null-safe', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});
