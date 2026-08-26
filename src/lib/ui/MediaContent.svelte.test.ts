// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => {
  const fetchMedia = vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>();

  return { fetchMedia, commands: { fetchMedia } };
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import MediaContent from './MediaContent.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
});

test.each([
  { kind: 'video' as const, selector: 'video', width: 1920, height: 1080 },
  { kind: 'audio' as const, selector: 'audio', width: null, height: null },
  { kind: 'file' as const, selector: 'a[download="report.pdf"]', width: null, height: null },
])(
  'renders a $kind attachment from the original media',
  async ({ kind, selector, width, height }) => {
    core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
    const instance = mount(MediaContent, {
      target: document.body,
      props: {
        kind,
        source: `mxc://example.org/${kind}`,
        mime: `${kind}/*`,
        body: 'report.pdf',
        width,
        height,
      },
    });

    await tick();
    await Promise.resolve();
    await tick();

    expect(core.fetchMedia).toHaveBeenCalledWith(`mxc://example.org/${kind}`, 0, 0);
    expect(document.querySelector(selector)).not.toBeNull();
    if (kind === 'video') {
      expect(document.querySelector('video')?.getAttribute('width')).toBe('1920');
      expect(document.querySelector('video')?.getAttribute('height')).toBe('1080');
    }
    await unmount(instance);
  }
);

test('labels unavailable attachments', async () => {
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockResolvedValueOnce(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind: 'file',
      source: 'mxc://example.org/unavailable-file',
      mime: 'application/pdf',
      body: 'report.pdf',
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.media-error')?.textContent).toContain(
    'report.pdf: Media unavailable'
  );
  document.querySelector<HTMLButtonElement>('.retry-media')?.click();
  await Promise.resolve();
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.media-error')).toBeNull();
  await unmount(instance);
});
