import { expect, test } from 'vitest';

import {
  filesFrom,
  previewKind,
  restoreFile,
  stageFiles,
  toggleSpoiler,
  unstageFile,
} from './composer-files';

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

test('a transfer without files yields nothing', () => {
  expect(filesFrom(null)).toEqual([]);
  expect(filesFrom({ files: [], items: [] } as unknown as DataTransfer)).toEqual([]);
});

test('an item list stands in for an empty file list', () => {
  const pasted = file('pasted.png');
  const transfer = {
    files: [],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => pasted },
    ],
  } as unknown as DataTransfer;

  expect(filesFrom(transfer)).toEqual([pasted]);
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

test('a staged file starts unmarked and only the addressed one toggles', () => {
  let id = 0;
  const staged = stageFiles([], [file('one.png'), file('two.png')], () => id++);

  expect(staged.map((item) => item.spoiler)).toEqual([false, false]);
  expect(toggleSpoiler(staged, 1).map((item) => item.spoiler)).toEqual([false, true]);
  expect(toggleSpoiler(toggleSpoiler(staged, 1), 1).map((item) => item.spoiler)).toEqual([
    false,
    false,
  ]);
});

test('only images and videos get a preview and a spoiler', () => {
  expect(previewKind(file('one.png'))).toBe('image');
  expect(previewKind(new File(['x'], 'clip.webm', { type: 'video/webm' }))).toBe('video');
  expect(previewKind(new File(['x'], 'report.pdf', { type: 'application/pdf' }))).toBeNull();
});

test('an undone removal puts the file back where it was, once', () => {
  let id = 0;
  const staged = stageFiles([], [file('a.png'), file('b.png'), file('c.png')], () => id++);
  const removed = staged[1];
  const without = unstageFile(staged, removed.id);

  const restored = restoreFile(without, removed, 1);
  expect(restored.map((item) => item.file.name)).toEqual(['a.png', 'b.png', 'c.png']);
  expect(restoreFile(restored, removed, 1)).toEqual(restored);
});
