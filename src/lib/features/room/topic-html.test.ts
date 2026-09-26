import { expect, test } from 'vitest';

import { topicHtml } from './topic-html';

test('links a bare url', () => {
  expect(topicHtml('Rules at https://example.org/coc')).toBe(
    '<p>Rules at <a href="https://example.org/coc">https://example.org/coc</a></p>'
  );
});

test('renders markdown emphasis, strikethrough and links', () => {
  expect(topicHtml('**Be kind**, ~~no spam~~, [site](https://example.org)')).toBe(
    '<p><strong>Be kind</strong>, <s>no spam</s>, <a href="https://example.org">site</a></p>'
  );
});

test('keeps line breaks', () => {
  expect(topicHtml('one\ntwo')).toBe('<p>one<br />\ntwo</p>');
});

test('escapes raw html instead of rendering it', () => {
  expect(topicHtml('<img src=x onerror=alert(1)>')).toBe(
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>'
  );
});

test('refuses a javascript link and a remote image', () => {
  const html = topicHtml('[x](javascript:alert(1)) ![y](https://example.org/y.png)');
  expect(html).not.toContain('href="javascript');
  expect(html).not.toContain('<img');
});
