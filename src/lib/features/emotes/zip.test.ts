import fc from 'fast-check';
import { expect, test } from 'vitest';

import { readZip, writeZip } from './zip';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

test('an archive round-trips its entries', () => {
  const written = writeZip([
    { name: 'pack.json', bytes: new TextEncoder().encode('{"version":1}') },
    { name: 'images/0-blob-wave.png', bytes: bytes(0x89, 0x50, 0x4e, 0x47) },
  ]);
  const read = readZip(written);

  expect([...read.keys()]).toEqual(['pack.json', 'images/0-blob-wave.png']);
  expect(new TextDecoder().decode(read.get('pack.json'))).toBe('{"version":1}');
  expect(read.get('images/0-blob-wave.png')).toEqual(bytes(0x89, 0x50, 0x4e, 0x47));
});

test('a name outside ascii survives the round trip', () => {
  const read = readZip(writeZip([{ name: 'images/0-ブイ.png', bytes: bytes(1, 2, 3) }]));

  expect(read.get('images/0-ブイ.png')).toEqual(bytes(1, 2, 3));
});

test('an empty entry round-trips', () => {
  const read = readZip(writeZip([{ name: 'empty.bin', bytes: new Uint8Array() }]));

  expect(read.get('empty.bin')).toEqual(new Uint8Array());
});

test('a flipped byte is caught rather than imported', () => {
  const written = writeZip([{ name: 'a.png', bytes: bytes(1, 2, 3, 4) }]);
  const start = written.indexOf(4, 30);
  written[start] = 9;

  expect(() => readZip(written)).toThrow(/corrupt/u);
});

test('something that is not an archive is rejected', () => {
  expect(() => readZip(new TextEncoder().encode('not a zip at all'))).toThrow(/Not a zip/u);
});

test('any set of entries round-trips', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.record({
          name: fc.string({ minLength: 1 }).filter((name) => !name.endsWith('/')),
          bytes: fc.uint8Array(),
        }),
        { selector: (entry) => entry.name }
      ),
      (entries) => {
        const read = readZip(writeZip(entries));
        expect(read.size).toBe(entries.length);
        for (const entry of entries) {
          expect(read.get(entry.name)).toEqual(entry.bytes);
        }
      }
    )
  );
});
