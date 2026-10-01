// @vitest-environment happy-dom
import { afterEach, expect, test } from 'vitest';
import { adoptFavorites, favoriteGifs } from '#lib/features/gif/favorites.svelte.js';
import { SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
import { workspaceDocument } from '#lib/settings/sync-documents.js';
import { convertV1Workspace } from './documents.js';

const mediaUrl = 'https://media.tenor.com/abc/cat.gif';
afterEach(() => {
  adoptFavorites([]);
  localStorage.clear();
});

test('migrates v1 GIF provider URLs and the old Klipy proxy shape, retaining the source', () => {
  const source = {
    gifs: [
      {
        url:
          'mxc://gifs.sable.moe/klipy_' +
          btoa('path/cat.gif').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
        title: 'Old cat',
        width: 10,
      },
      { mediaUrl, title: 'New cat' },
      { mediaUrl: 'https://evil.example/cat.gif' },
    ],
  };
  const before = structuredClone(source);
  const document = workspaceDocument(new SpaceSidebar());
  expect(document.adopt(convertV1Workspace(source))).toBe(true);
  expect(favoriteGifs().map((gif) => gif.mediaUrl)).toEqual([
    'https://static.klipy.com/ii/path/cat.gif',
    mediaUrl,
  ]);
  expect(source).toEqual(before);
});
