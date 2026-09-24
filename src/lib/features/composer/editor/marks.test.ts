// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import {
  bold,
  cm,
  enter,
  inlineCode,
  italic,
  replaceText,
  resetModel,
  softBreak,
  strike,
  tx,
} from './model-harness';
import { preferences } from '#lib/settings/preferences.svelte.js';

afterEach(() => {
  preferences.enterForNewline = false;
  resetModel();
});

test('bolding a selection adds strong tags', () => {
  let model = cm('<p>aa{bb}|cc</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<strong>{bb}|</strong>cc</p>');

  model = cm('<p>aa|{bb}cc</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<strong>|{bb}</strong>cc</p>');
});

test('unbolding a selection inside a bold run splits it', () => {
  const model = cm('<p><strong>aa{bb}|cc</strong></p>');
  bold(model);
  expect(tx(model)).toBe('<p><strong>aa</strong>{bb}|<strong>cc</strong></p>');
});

test('unformatting a nested node keeps the outer mark', () => {
  const model = cm('<p>aa<em>b<strong>{bc}|</strong></em>c</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<em>b{bc}|</em>c</p>');
});

test('partially unformatting a nested node keeps the rest bold', () => {
  const model = cm('<p>aa<em>b<strong>b{c}|</strong></em>c</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<em>b</em><strong><em>b</em></strong><em>{c}|</em>c</p>');
});

test('unformatting the outer mark keeps the inner one', () => {
  const model = cm('<p>aa<em>{b<strong>bc}|</strong></em>c</p>');
  italic(model);
  expect(tx(model)).toBe('<p>aa{b<strong>bc}|</strong>c</p>');
});

test('a mixed selection is unbolded as a whole first, then bolded as a whole', () => {
  const model = cm('<p>aa<em>{b<strong>bc}|</strong></em>c</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<em>{bbc}|</em>c</p>');
  bold(model);
  expect(tx(model)).toBe('<p>aa<strong><em>{bbc}|</em></strong>c</p>');
});

test('formatting across a line break applies to both lines', () => {
  const model = cm('<p>aa<strong>a<br>{bbb<br>}|cc</strong>c</p>');
  italic(model);
  expect(tx(model)).toBe('<p>aa<strong>a<br><em>{bbb<br>}|</em>cc</strong>c</p>');
});

test('formatting with a collapsed selection applies to what is typed next', () => {
  const model = cm('<p>aaa|bbb</p>');
  bold(model);
  italic(model);
  expect(tx(model)).toBe('<p>aaa|bbb</p>');
  replaceText(model, 'ccc');
  expect(tx(model)).toBe('<p>aaa<strong><em>ccc|</em></strong>bbb</p>');
});

test('unformatting with a collapsed selection removes it from what is typed next', () => {
  const model = cm('<p><strong>aaa|bbb</strong></p>');
  bold(model);
  replaceText(model, 'ccc');
  expect(tx(model)).toBe('<p><strong>aaa</strong>ccc|<strong>bbb</strong></p>');
});

test('formatting and unformatting with a collapsed selection combine', () => {
  const model = cm('<p><em>aaa|bbb</em></p>');
  bold(model);
  italic(model);
  replaceText(model, 'ccc');
  expect(tx(model)).toBe('<p><em>aaa</em><strong>ccc|</strong><em>bbb</em></p>');
});

test('toggling a format again before typing cancels it', () => {
  const model = cm('<p>aaa|</p>');
  bold(model);
  bold(model);
  replaceText(model, 'b');
  expect(tx(model)).toBe('<p>aaab|</p>');
});

test('formatting before typing anything applies the formatting', () => {
  const model = cm('<p>|</p>');
  bold(model);
  replaceText(model, 'd');
  expect(tx(model)).toBe('<p><strong>d|</strong></p>');
});

test('formatting in an empty paragraph after a full one applies', () => {
  const model = cm('<p>A</p><p>|</p>');
  bold(model);
  replaceText(model, 'B');
  expect(tx(model)).toBe('<p>A</p><p><strong>B|</strong></p>');
});

test('inline code on part of a word', () => {
  const model = cm('<p>w{or}|d</p>');
  inlineCode(model);
  expect(tx(model)).toBe('<p>w<code>{or}|</code>d</p>');
});

test('inline code excludes other marks', () => {
  const model = cm('<p><strong>w{or}|d</strong></p>');
  inlineCode(model);
  expect(tx(model)).toBe('<p><strong>w</strong><code>{or}|</code><strong>d</strong></p>');
});

test('a mark survives a soft line break', () => {
  const model = cm('<p>|</p>');
  strike(model);
  replaceText(model, 'foo');
  expect(tx(model)).toBe('<p><del>foo|</del></p>');
  softBreak(model);
  replaceText(model, 'bar');
  expect(tx(model)).toBe('<p><del>foo<br>bar|</del></p>');
});

test('a mark survives a paragraph split when enter makes newlines', () => {
  preferences.enterForNewline = true;
  const model = cm('<p>|</p>');
  strike(model);
  replaceText(model, 'foo');
  enter(model);
  replaceText(model, 'bar');
  expect(tx(model)).toBe('<p><del>foo</del></p><p><del>bar|</del></p>');
});

test('the selection stays where it was after bolding', () => {
  const model = cm('<p>{some}| different nodes</p>');
  bold(model);
  expect(tx(model)).toBe('<p><strong>{some}|</strong> different nodes</p>');
});
