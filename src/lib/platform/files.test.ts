import { expect, test, vi } from 'vitest';

import { fileNameFromPath, filtersFor, mimeFromName, savesNatively } from './files';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

test('the web build keeps the browser download, having no native dialog', () => {
  expect(savesNatively()).toBe(false);
});

test('a picked path yields its basename on either separator', () => {
  expect(fileNameFromPath('/home/erwan/holiday.png', 0)).toBe('holiday.png');
  expect(fileNameFromPath('C:\\Users\\erwan\\holiday.png', 0)).toBe('holiday.png');
});

test('a path with no basename still names the attachment', () => {
  expect(fileNameFromPath('/', 2)).toBe('attachment-3');
});

test('the media type comes from the extension, which the path does not carry', () => {
  expect(mimeFromName('holiday.PNG')).toBe('image/png');
  expect(mimeFromName('clip.mov')).toBe('video/quicktime');
});

test('an unknown or absent extension falls back to a generic type', () => {
  expect(mimeFromName('archive.zzz')).toBe('application/octet-stream');
  expect(mimeFromName('README')).toBe('application/octet-stream');
});

test('a wildcard accept expands to every extension of that type', () => {
  const filters = filtersFor('image/*');
  expect(filters).toHaveLength(1);
  expect(filters?.[0].extensions).toContain('png');
  expect(filters?.[0].extensions).toContain('webp');
  expect(filters?.[0].extensions).not.toContain('mp4');
});

test('an exact accept matches only that type', () => {
  expect(filtersFor('application/pdf')?.[0].extensions).toEqual(['pdf']);
});

test('accepting anything leaves the dialog unfiltered', () => {
  expect(filtersFor('*/*')).toBeUndefined();
  expect(filtersFor('')).toBeUndefined();
});

test('an accept naming nothing known leaves the dialog unfiltered', () => {
  expect(filtersFor('application/x-nonesuch')).toBeUndefined();
});
