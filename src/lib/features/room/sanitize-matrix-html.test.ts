// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { sanitizeMatrixHtml } from './sanitize-matrix-html';

test('keeps Matrix formatting while removing executable markup and unsafe links', () => {
  const html = sanitizeMatrixHtml(
    '<strong>Safe</strong><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a><a href="/settings">relative</a><a href="matrix:u/alice:example.org">pill</a>'
  );

  expect(html).toContain('<strong>Safe</strong>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('href="/settings"');
  expect(html).toContain('href="matrix:u/alice:example.org"');
  expect(html).toContain('rel="noreferrer noopener"');
});
