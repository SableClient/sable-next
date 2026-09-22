// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import {
  backspace,
  cm,
  codeBlock,
  enter,
  press,
  quote,
  replaceText,
  resetModel,
  sent,
  softBreak,
  tx,
} from './model-harness';

afterEach(resetModel);

test('a line break at the end of a line makes a new line', () => {
  const model = cm('<p>abc|</p>');
  softBreak(model);
  expect(tx(model)).toBe('<p>abc<br>|</p>');
});

test('a line break at the beginning of a line makes a new line above', () => {
  const model = cm('<p>|abc</p>');
  softBreak(model);
  expect(tx(model)).toBe('<p><br>|abc</p>');
});

test('a line break in the middle of a line splits it', () => {
  const model = cm('<p>123|abc</p>');
  softBreak(model);
  expect(tx(model)).toBe('<p>123<br>|abc</p>');
});

test('a line break with text selected replaces the selection', () => {
  const model = cm('<p>123{XYZ}|abc</p>');
  softBreak(model);
  expect(tx(model)).toBe('<p>123<br>|abc</p>');
});

test('multiple line breaks can be added', () => {
  const model = cm('<p>123|abc</p>');
  softBreak(model);
  softBreak(model);
  softBreak(model);
  expect(tx(model)).toBe('<p>123<br><br><br>|abc</p>');
});

test('typing after a line break lands on the new line', () => {
  const model = cm('<p>a|</p>');
  softBreak(model);
  replaceText(model, 'b');
  expect(tx(model)).toBe('<p>a<br>b|</p>');
});

test('a line break in an empty composer is not a message', () => {
  const model = cm('<p>|</p>');
  softBreak(model);
  expect(model.isEmpty()).toBe(true);
  enter(model);
  expect(sent()).toBe(1);
});

test('backspacing a selection across a line break deletes it', () => {
  const model = cm('<p>abc{<br>de}|f</p>');
  backspace(model);
  expect(tx(model)).toBe('<p>abc|f</p>');
});

test('enter in a code block adds a line as text', () => {
  const model = cm('<pre>Test|</pre>');
  enter(model);
  expect(tx(model)).toBe('<pre><code>Test\n|</code></pre>');
  expect(sent()).toBe(0);
});

test('enter at the start of a code block adds the line break there', () => {
  const model = cm('<pre>|Test</pre>');
  enter(model);
  expect(tx(model)).toBe('<pre><code>\n|Test</code></pre>');
});

test('enter on the blank last line of a code block exits it', () => {
  const model = cm('<pre>code|</pre>');
  enter(model);
  enter(model);
  expect(tx(model)).toBe('<pre><code>code</code></pre><p>|</p>');
  replaceText(model, 'after');
  expect(tx(model)).toBe('<pre><code>code</code></pre><p>after|</p>');
});

test('a double enter in an empty code block removes it and typing continues in prose', () => {
  const model = cm('<p>|</p>');
  codeBlock(model);
  expect(tx(model)).toBe('<pre><code>|</code></pre>');
  enter(model);
  enter(model);
  expect(tx(model)).toBe('<p>|</p>');
  replaceText(model, 'asd');
  expect(tx(model)).toBe('<p>asd|</p>');
});

test('a code block in the middle of text is exited by shift+arrow, not by enter', () => {
  const model = cm('<p>ASDA</p><pre>|Test</pre><p>ASD</p>');
  enter(model);
  expect(tx(model)).toBe('<p>ASDA</p><pre><code>\n|Test</code></pre><p>ASD</p>');
  expect(sent()).toBe(0);

  const fresh = cm('<p>ASDA</p><pre>|Test</pre><p>ASD</p>');
  press(fresh, 'ArrowUp', { shift: true });
  expect(tx(fresh)).toBe('<p>ASDA|</p><pre><code>Test</code></pre><p>ASD</p>');
  press(fresh, 'ArrowDown', { shift: true });
  expect(tx(fresh)).toBe('<p>ASDA</p><pre><code>|Test</code></pre><p>ASD</p>');
});

test('enter in a quote sends, a line break stays inside it', () => {
  const model = cm('<blockquote><p>Left|Right</p></blockquote>');
  softBreak(model);
  expect(tx(model)).toBe('<blockquote><p>Left<br>|Right</p></blockquote>');
  enter(model);
  expect(sent()).toBe(1);
});

test('a double line break at the end of a quote exits it', () => {
  const model = cm('<blockquote><p>Text|</p></blockquote>');
  softBreak(model);
  softBreak(model);
  expect(tx(model)).toBe('<blockquote><p>Text</p></blockquote><p>|</p>');
});

test('a double line break mid-quote does not exit it', () => {
  const model = cm('<blockquote><p>Left|</p><p>Right</p></blockquote>');
  softBreak(model);
  softBreak(model);
  expect(tx(model)).toBe('<blockquote><p>Left<br><br>|</p><p>Right</p></blockquote>');
});

test('the quote toggle lifts the paragraph back out', () => {
  const model = cm('<p>A|</p>');
  quote(model);
  expect(tx(model)).toBe('<blockquote><p>A|</p></blockquote>');
  quote(model);
  expect(tx(model)).toBe('<p>A|</p>');
});

test('a heading exits into a paragraph on a line break', () => {
  const model = cm('<h2>Title|</h2>');
  softBreak(model);
  replaceText(model, 'body');
  expect(tx(model)).toBe('<h2>Title</h2><p>body|</p>');
});

test('a line break mid-heading stays in the heading', () => {
  const model = cm('<h2>Ti|tle</h2>');
  softBreak(model);
  expect(tx(model)).toBe('<h2>Ti<br>|tle</h2>');
});

test('subtext exits into a paragraph on a line break', () => {
  const model = cm('<sub data-md="-#">note|</sub>');
  softBreak(model);
  replaceText(model, 'body');
  expect(tx(model)).toBe('<sub data-md="-#">note</sub><p>body|</p>');
});

test('backspace at the start of subtext turns it into a paragraph', () => {
  const model = cm('<sub data-md="-#">|note</sub>');
  backspace(model);
  expect(tx(model)).toBe('<p>|note</p>');
});

test('the code block toggle turns prose into code and back', () => {
  const model = cm('<p>ab|c</p>');
  codeBlock(model);
  expect(tx(model)).toBe('<pre><code>ab|c</code></pre>');
  codeBlock(model);
  expect(tx(model)).toBe('<p>ab|c</p>');
});

test('the code block toggle over several paragraphs converts each', () => {
  const model = cm('<p>{a</p><p>b}|</p>');
  codeBlock(model);
  expect(tx(model)).toBe('<pre><code>{a</code></pre><pre><code>b}|</code></pre>');
});
