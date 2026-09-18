// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { Slice } from 'prosemirror-model';

import { filesFromSources, pastedImageSources } from './pasted-images';
import { parseMatrixHtml } from './schema';

function sliceOf(html: string): Slice {
  return new Slice(parseMatrixHtml(html).content, 0, 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pastedImageSources', () => {
  test('reads a blob url off an image-only paste', () => {
    expect(pastedImageSources(sliceOf('<img src="blob:tauri://localhost/abc">'))).toEqual([
      'blob:tauri://localhost/abc',
    ]);
  });

  test('leaves a remote image to the normal paste path', () => {
    expect(pastedImageSources(sliceOf('<img src="https://example.org/a.png">'))).toEqual([]);
  });

  test('leaves a paste that carries text as well', () => {
    expect(pastedImageSources(sliceOf('<p>look <img src="blob:x"></p>'))).toEqual([]);
  });
});

describe('filesFromSources', () => {
  test('names the fetched blob by its type', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })) })
    );

    const [file] = await filesFromSources(['blob:x']);
    expect(file.name).toBe('pasted-image.jpg');
    expect(file.type).toBe('image/jpeg');
  });

  test('drops a source that does not resolve to an image', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob(['x'], { type: 'text/html' })) })
    );

    expect(await filesFromSources(['blob:x'])).toEqual([]);
  });

  test('drops a source that cannot be fetched', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('gone')));

    expect(await filesFromSources(['blob:x'])).toEqual([]);
  });
});
