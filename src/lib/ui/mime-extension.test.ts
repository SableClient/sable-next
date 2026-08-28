import { expect, test } from 'vitest';

import { mimeExtension } from './mime-extension.js';

test.each([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpeg'],
  ['image/svg+xml', 'svg+xml'],
  ['text/plain; charset=utf-8', 'plain'],
  ['audio/mpeg', 'mpeg'],
])('extracts %s as %s', (mime, expected) => {
  expect(mimeExtension(mime)).toBe(expected);
});

test.each([null, '', 'no-slash-here'])('returns null for %s', (mime) => {
  expect(mimeExtension(mime)).toBeNull();
});
