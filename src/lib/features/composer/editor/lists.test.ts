// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import {
  backspace,
  cm,
  enter,
  indent,
  orderedList,
  replaceText,
  resetModel,
  sent,
  tx,
  unindent,
  unorderedList,
} from './model-harness';

const defaultRichTextComposer = preferences.richTextComposer;

beforeEach(() => {
  preferences.richTextComposer = true;
});

afterEach(() => {
  resetModel();
  preferences.richTextComposer = defaultRichTextComposer;
});

test('creating an ordered list and writing', () => {
  const model = cm('|');
  orderedList(model);
  expect(tx(model)).toBe('<ol><li><p>|</p></li></ol>');
  replaceText(model, 'abcd');
  expect(tx(model)).toBe('<ol><li><p>abcd|</p></li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>abcd</p></li><li><p>|</p></li></ol>');
  replaceText(model, 'efgh');
  expect(tx(model)).toBe('<ol><li><p>abcd</p></li><li><p>efgh|</p></li></ol>');
});

test('creating an unordered list', () => {
  const model = cm('|');
  unorderedList(model);
  expect(tx(model)).toBe('<ul><li><p>|</p></li></ul>');
});

test('removing a list item', () => {
  let model = cm('<ol><li>abcd</li><li>|</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>abcd</p></li></ol><p>|</p>');
  expect(sent()).toBe(0);

  model = cm('<ol><li>abcd</li><li>|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>abcd|</p></li></ol>');

  model = cm('<ol><li>|</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<p>|</p>');

  model = cm('<ol><li>|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<p>|</p>');
});

test('backspacing in a list leaving some text keeps the items unchanged', () => {
  const model = cm('<ol><li>abcd</li><li>ef{gh}|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>abcd</p></li><li><p>ef|</p></li></ol>');
});

test('backspacing the whole of the second item into part of the first leaves one item', () => {
  const model = cm('<ol><li>ab{cd</li><li>efgh}|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>ab|</p></li></ol>');
});

test('backspacing an empty second item into the whole of the first leaves an empty item', () => {
  const model = cm('<ol><li>{abcd</li><li>}|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>|</p></li></ol>');
});

test('backspacing the trailing part of a list item', () => {
  const model = cm('<ol><li>abc{def}|</li><li><strong>abcd</strong>ef</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<ol><li><p>abc|</p></li><li><p><strong>abcd</strong>ef</p></li></ol>');
});

test('backspacing the whole list', () => {
  const model = cm('<p>Text{</p><ul><li>First</li><li>Second}|</li></ul><p>More text</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>Text|</p><p>More text</p>');
});

test('backspacing through several list items', () => {
  const model = cm('<p>Text</p><ul><li>Fi{rst</li><li>Seco}|nd</li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<p>Text</p><ul><li><p>Fi|nd</p></li></ul>');
});

test('backspacing at the start of the first item lifts it, then joins the previous block', () => {
  const model = cm('<p>Text</p><ul><li>|First</li><li>Second</li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<p>Text</p><p>|First</p><ul><li><p>Second</p></li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<p>Text|First</p><ul><li><p>Second</p></li></ul>');
});

test('backspacing at the start of the first item extracts it when nothing precedes', () => {
  const model = cm('<ul><li>|First</li><li>Second</li></ul>');
  backspace(model);
  expect(tx(model)).toBe('<p>|First</p><ul><li><p>Second</p></li></ul>');
});

test('entering with the whole item selected empties it', () => {
  const model = cm('<ol><li>{abcd}|</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p></p></li><li><p>|</p></li></ol>'.replaceAll('<p></p>', ''));
});

test('entering with subsequent items', () => {
  const model = cm('<ol><li>abcd|</li><li>ef</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>abcd</p></li><li><p>|</p></li><li><p>ef</p></li></ol>');
});

test('entering mid text node', () => {
  const model = cm('<ol><li>ab|gh</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li><li><p>|gh</p></li></ol>');
});

test('entering mid text node with subsequent items', () => {
  const model = cm('<ol><li>ab|cd</li><li>ef</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li><li><p>|cd</p></li><li><p>ef</p></li></ol>');
});

test('entering mid text node with formatting', () => {
  const model = cm('<ol><li><strong>abc|def</strong></li></ol>');
  enter(model);
  expect(tx(model)).toBe(
    '<ol><li><p><strong>abc</strong></p></li><li><p><strong>|def</strong></p></li></ol>'
  );
});

test('entering mid text node with multiple formatting', () => {
  const model = cm('<ol><li><em><strong>abc|def</strong></em></li></ol>');
  enter(model);
  expect(tx(model)).toBe(
    '<ol><li><p><strong><em>abc</em></strong></p></li><li><p><strong><em>|def</em></strong></p></li></ol>'
  );
});

test('entering mid text node with trailing formatting', () => {
  const model = cm('<ol><li>ab<strong>c|def</strong></li></ol>');
  enter(model);
  expect(tx(model)).toBe(
    '<ol><li><p>ab<strong>c</strong></p></li><li><p><strong>|def</strong></p></li></ol>'
  );
});

test('entering mid text node with a selection', () => {
  const model = cm('<ol><li>ab{cdef}|gh</li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li><li><p>|gh</p></li></ol>');
});

test('removing a list with enter', () => {
  const model = cm('|');
  orderedList(model);
  enter(model);
  expect(tx(model)).toBe('<p>|</p>');
  expect(sent()).toBe(0);
});

test('removing a trailing list item with the list toggle', () => {
  const model = cm('<ol><li>abc</li><li>|</li></ol>');
  orderedList(model);
  expect(tx(model)).toBe('<ol><li><p>abc</p></li></ol><p>|</p>');
});

test('removing a formatted trailing item with enter keeps the formatting', () => {
  const model = cm('<ol><li><strong>abc</strong></li><li><strong>|</strong></li></ol>');
  enter(model);
  expect(tx(model)).toBe('<ol><li><p><strong>abc</strong></p></li></ol><p>|</p>');
});

test('removing a trailing list item then typing', () => {
  const model = cm('<ol><li>abc</li><li>|</li></ol>');
  enter(model);
  replaceText(model, 'def');
  expect(tx(model)).toBe('<ol><li><p>abc</p></li></ol><p>def|</p>');
});

test('updating the list type', () => {
  const model = cm('<ol><li>ab</li><li>cd|</li></ol>');
  unorderedList(model);
  expect(tx(model)).toBe('<ul><li><p>ab</p></li><li><p>cd|</p></li></ul>');
  orderedList(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li><li><p>cd|</p></li></ol>');
});

test('moving list item content out', () => {
  const model = cm('<ol><li>ab</li><li>cd|</li></ol>');
  orderedList(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li></ol><p>cd|</p>');
});

test('appending a new list to the previous one', () => {
  const model = cm('<ol><li>ab</li></ol><p>cd|</p>');
  orderedList(model);
  expect(tx(model)).toBe('<ol><li><p>ab</p></li><li><p>cd|</p></li></ol>');
});

test('creating a list of a different type does not merge', () => {
  const model = cm('<ul><li>foo</li></ul><p>bar|</p>');
  orderedList(model);
  expect(tx(model)).toBe('<ul><li><p>foo</p></li></ul><ol><li><p>bar|</p></li></ol>');
});

test('creating a new list immediately after an old one joins them', () => {
  const model = cm('<p>abc|</p>');
  unorderedList(model);
  enter(model);
  enter(model);
  replaceText(model, 'def');
  unorderedList(model);
  expect(tx(model)).toBe('<ul><li><p>abc</p></li><li><p>def|</p></li></ul>');
});

test('indenting a single list item', () => {
  const model = cm('<ul><li>First item</li><li>Second item|</li><li>Third item</li></ul>');
  indent(model);
  expect(tx(model)).toBe(
    '<ul><li><p>First item</p><ul><li><p>Second item|</p></li></ul></li><li><p>Third item</p></li></ul>'
  );
});

test('indenting a single empty list item', () => {
  const model = cm('<ul><li>First item</li><li>|</li><li>Third item</li></ul>');
  indent(model);
  expect(tx(model)).toBe(
    '<ul><li><p>First item</p><ul><li><p>|</p></li></ul></li><li><p>Third item</p></li></ul>'
  );
});

test('indenting several list items', () => {
  const model = cm('<ul><li>First item</li><li>{Second item</li><li>Third item}|</li></ul>');
  indent(model);
  expect(tx(model)).toBe(
    '<ul><li><p>First item</p><ul><li><p>{Second item</p></li><li><p>Third item}|</p></li></ul></li></ul>'
  );
});

test('unindenting several items', () => {
  const model = cm(
    '<ul><li><p>First item</p><ul><li>{Second item</li><li>Third item}|</li></ul></li></ul>'
  );
  unindent(model);
  expect(tx(model)).toBe(
    '<ul><li><p>First item</p></li><li><p>{Second item</p></li><li><p>Third item}|</p></li></ul>'
  );
});

test('unindenting a middle list item', () => {
  const model = cm(
    '<ul><li><p>First item</p><ul><li>Second item</li><li>{Third item}|</li><li>Fourth item</li></ul></li></ul>'
  );
  unindent(model);
  expect(tx(model)).toBe(
    '<ul><li><p>First item</p><ul><li><p>Second item</p></li></ul></li><li><p>{Third item}|</p><ul><li><p>Fourth item</p></li></ul></li></ul>'
  );
});

test('backspacing in an empty list then creating a new list', () => {
  const model = cm('<ol><li>|</li></ol>');
  backspace(model);
  expect(tx(model)).toBe('<p>|</p>');
  unorderedList(model);
  expect(tx(model)).toBe('<ul><li><p>|</p></li></ul>');
});
