import { expect, test } from 'vitest';

import { filesFrom, formatSize, stageFiles, unstageFile } from './composer-files';

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

test('sizes read in the largest unit that keeps a whole number', () => {
  expect(formatSize(512)).toBe('512 B');
  expect(formatSize(2048)).toBe('2 KB');
  expect(formatSize(1_500_000)).toBe('1.4 MB');
});

test('a transfer without files yields nothing', () => {
  expect(filesFrom(null)).toEqual([]);
  expect(filesFrom({ files: [] } as unknown as DataTransfer)).toEqual([]);
});

test('staging appends and keeps every entry addressable', () => {
  let id = 0;
  const nextId = (): number => id++;

  const one = stageFiles([], [file('one.png')], nextId);
  const both = stageFiles(one, [file('two.png')], nextId);

  expect(both.map((item) => item.file.name)).toEqual(['one.png', 'two.png']);
  expect(both.map((item) => item.id)).toEqual([0, 1]);
});

test('unstaging removes only the addressed entry', () => {
  let id = 0;
  const staged = stageFiles([], [file('one.png'), file('two.png')], () => id++);

  expect(unstageFile(staged, 0).map((item) => item.file.name)).toEqual(['two.png']);
  expect(unstageFile(staged, 9)).toHaveLength(2);
});
