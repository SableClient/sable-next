// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { backspace, cm, resetModel, tx } from './model-harness';

afterEach(resetModel);

test('backspacing a selection deletes it', () => {
  const model = cm('<p>a{bc}|</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>a|</p>');
});

test('backspacing a backwards selection deletes it', () => {
  const model = cm('<p>a|{bc}</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>a|</p>');
});

test('backspacing at the very start does nothing', () => {
  const model = cm('<p>|abc</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>|abc</p>');
});

test('deleting across two identical marks joins them', () => {
  const model = cm('<p><strong>bo{ld</strong> plain <strong>BO}|LD</strong></p>');
  backspace(model);
  expect(tx(model)).toBe('<p><strong>bo|LD</strong></p>');
});

test('deleting across list items joins them', () => {
  const model = cm('<ol><li>1{1</li><li>2}|2</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>1|2</p></li></ol>');
});

test('deleting across two lists joins them', () => {
  const model = cm('<ol><li>1{1</li></ol><p>x</p><ol><li>2}|2</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>1|2</p></li></ol>');
});

test('deleting across different marks keeps what is left of each', () => {
  const model = cm(
    '<p><strong><em>some {italic</em></strong> and}| <strong>bold</strong> text</p>'
  );
  backspace(model);
  expect(tx(model)).toBe('<p><strong><em>some |</em></strong> <strong>bold</strong> text</p>');
});

test('deleting inside a nested structure keeps the structure', () => {
  const model = cm('<ul><li>A</li><li><strong>B{B</strong><strong>C}|C</strong></li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<ul><li><p>A</p></li><li><p><strong>B|C</strong></p></li></ul>');
});

test('deleting an empty second list item into the first', () => {
  const model = cm('<ul><li>A{</li><li>}|</li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<ul><li><p>A|</p></li></ul>');
});

test('backspacing a paragraph into the previous one joins them', () => {
  const model = cm('<p>a</p><p>|b</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>a|b</p>');
});

test('backspacing at the start of a heading turns it into a paragraph first', () => {
  const model = cm('<h1>|Title</h1>');
  backspace(model);
  expect(tx(model)).toBe('<p>|Title</p>');
});

test('backspacing at the start of a quote lifts the paragraph out', () => {
  const model = cm('<blockquote><p>|a</p></blockquote>');
  backspace(model);
  expect(tx(model)).toBe('<p>|a</p>');
});

test('deleting all the text inside a mark removes the mark', () => {
  const model = cm('<p>abc<br><strong>{def<br>gh}|</strong>ijk</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>abc<br>|ijk</p>');
});

test('deleting the initial text but not the whole mark keeps it', () => {
  const model = cm('<p>abc<br><strong>{def<br>gh}|ijk</strong></p>');
  backspace(model);
  expect(tx(model)).toBe('<p>abc<br>|<strong>ijk</strong></p>');
});

test('backspacing a whole list with the text around it', () => {
  const model = cm('<p>Text{</p><ul><li>First</li><li>Second}|</li></ul><p>More text</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>Text|</p><p>More text</p>');
});
