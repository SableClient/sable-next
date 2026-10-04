// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { cm, press, resetModel, tx } from './model-harness';

afterEach(resetModel);

test('shift-tab removes up to four leading spaces from the line', () => {
  const model = cm('<pre><code>      a|b</code></pre>');
  press(model, 'Tab', { shift: true });
  expect(tx(model)).toBe('<pre><code>  a|b</code></pre>');
});

test('shift-tab on an unindented line leaves it alone', () => {
  const model = cm('<pre><code>a|b</code></pre>');
  press(model, 'Tab', { shift: true });
  expect(tx(model)).toBe('<pre><code>a|b</code></pre>');
});

test('tab indents every selected line', () => {
  const model = cm('<pre><code>{a\nb}|</code></pre>');
  press(model, 'Tab');
  expect(tx(model)).toBe('<pre><code>{    a\n    b}|</code></pre>');
});

test('shift-tab unindents every selected line', () => {
  const model = cm('<pre><code>{    a\n  b}|</code></pre>');
  press(model, 'Tab', { shift: true });
  expect(tx(model)).toBe('<pre><code>{a\nb}|</code></pre>');
});

test('arrow up at the start of a leading code block opens a line above it', () => {
  const model = cm('<pre><code>|ab</code></pre>');
  press(model, 'ArrowUp');
  expect(model.doc()?.firstChild?.type.name).toBe('paragraph');
  expect(model.doc()?.childCount).toBe(2);
});

test('arrow down at the end of a trailing code block opens a line below it', () => {
  const model = cm('<pre><code>ab|</code></pre>');
  press(model, 'ArrowDown');
  expect(model.doc()?.lastChild?.type.name).toBe('paragraph');
});

test('a lone newline or an empty code block is not pristine', () => {
  expect(cm('<p>|</p>').isPristine()).toBe(true);
  expect(cm('<p>a<br>|</p>').isPristine()).toBe(false);
  expect(cm('<pre><code>|</code></pre>').isPristine()).toBe(false);
});
