import { expect, test } from 'vitest';

import { escapeHtml, rainbowHtml } from './rainbow';

test('markup in the text is escaped, not emitted', () => {
  expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;');
  expect(rainbowHtml('<')).toContain('&lt;');
  expect(rainbowHtml('<')).not.toContain('<b');
});

test('every visible character gets its own colour', () => {
  const html = rainbowHtml('abc');

  expect(html.match(/data-mx-color/g)).toHaveLength(3);
  expect(new Set(html.match(/#[0-9a-f]{6}/g)).size).toBe(3);
});

test('whitespace is passed through uncoloured', () => {
  const html = rainbowHtml('a b');

  expect(html.match(/data-mx-color/g)).toHaveLength(2);
  expect(html).toContain('</span> <span');
});

test('an emoji stays one character', () => {
  expect(rainbowHtml('👨‍👩‍👧').match(/data-mx-color/g)).toHaveLength(1);
  expect(rainbowHtml('é').match(/data-mx-color/g)).toHaveLength(1);
});

test('text with nothing to colour is only escaped', () => {
  expect(rainbowHtml('   ')).toBe('   ');
  expect(rainbowHtml('')).toBe('');
});
