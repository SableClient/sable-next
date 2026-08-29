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

test('renders the extension badge and human-readable size for a file attachment', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind: 'file',
      source: 'mxc://example.org/file',
      mime: 'application/zip',
      body: 'archive.zip',
      size: 1_500_000,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.media-file-ext')?.textContent).toBe('zip');
  expect(document.querySelector('.media-file-size')?.textContent).toBe('1.5 MB');
  await unmount(instance);
});

test('offers a PDF as a file plus an action that opens the viewer', async () => {
  const onOpen = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind: 'file',
      source: 'mxc://example.org/pdf',
      mime: 'application/pdf',
      body: 'report.pdf',
      onOpen,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.pdf-viewer')).toBeNull();
  expect(document.querySelector('a[download="report.pdf"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('.media-file-open')?.click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('renders a voice message with a waveform when a waveform is present', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind: 'audio',
      source: 'mxc://example.org/voice',
      mime: 'audio/ogg',
      body: 'Voice message',
      durationMs: 4200,
      waveform: [0, 0.5, 1, 0.5, 0],
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.voice-message-player')).not.toBeNull();
  expect(document.querySelectorAll('.voice-bar')).toHaveLength(5);
  expect(document.querySelector('audio.media-content')).toBeNull();
  await unmount(instance);
});

test('falls back to the plain audio player when there is no waveform', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind: 'audio',
      source: 'mxc://example.org/audio-no-waveform',
      mime: 'audio/ogg',
      body: 'clip.ogg',
      waveform: null,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.voice-message-player')).toBeNull();
  expect(document.querySelector('audio.media-content')).not.toBeNull();
  await unmount(instance);
});

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
