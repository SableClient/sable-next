import { expect, test } from 'vitest';

import { formatBinarySize, formatByteSize } from './byte-size.js';

test.each([
  [0, '0 B'],
  [512, '512 B'],
  [999, '999 B'],
  [1000, '1.0 KB'],
  [1536, '1.5 KB'],
  [10_000, '10 KB'],
  [1_500_000, '1.5 MB'],
  [1_000_000_000, '1.0 GB'],
  [1_000_000_000_000, '1.0 TB'],
  [1_000_000_000_000_000, '1000 TB'],
])('formats %i bytes as %s', (bytes, expected) => {
  expect(formatByteSize(bytes)).toBe(expected);
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  'returns an empty string for an invalid size %s',
  (bytes) => {
    expect(formatByteSize(bytes)).toBe('');
  }
);

test('binary sizes use powers of 1024 and IEC units', () => {
  expect(formatBinarySize(128 * 1024 * 1024)).toBe('128 MiB');
  expect(formatBinarySize(1024 ** 3)).toBe('1.0 GiB');
  expect(formatBinarySize(512)).toBe('512 B');
  expect(formatBinarySize(-1)).toBe('');
});
