// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: new Promise(() => {}), destroy: () => Promise.resolve() }),
}));

import MediaContent from './MediaContent.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

test.each([
  { kind: 'video' as const, selector: 'video', width: 1920, height: 1080, start: /^Play / },
  { kind: 'audio' as const, selector: 'audio', width: null, height: null, start: null },
  {
    kind: 'file' as const,
    selector: 'a[download="report.pdf"]',
    width: null,
    height: null,
    start: /^Download/,
  },
])(
  'renders a $kind attachment from the original media',
  async ({ kind, selector, width, height, start }) => {
    core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
    render(MediaContent, {
      props: {
        kind,
        source: `mxc://example.org/${kind}`,
        mime: `${kind}/*`,
        filename: 'report.pdf',
        width,
        height,
      },
    });

    await settle();
    if (start !== null) {
      expect(core.fetchMedia).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: start }));
      await settle();
    }

    expect(core.fetchMedia).toHaveBeenCalledWith(`mxc://example.org/${kind}`, 0, 0);
    expect(document.querySelector(selector)).not.toBeNull();
    if (kind === 'video') {
      expect(document.querySelector('video')?.getAttribute('width')).toBe('1920');
      expect(document.querySelector('video')?.getAttribute('height')).toBe('1080');
    }
  }
);

test('renders the extension badge and human-readable size for a file attachment', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaContent, {
    props: {
      kind: 'file',
      source: 'mxc://example.org/file',
      mime: 'application/zip',
      filename: 'archive.zip',
      size: 1_500_000,
    },
  });

  await settle();

  expect(screen.getByText('zip')).toHaveClass('media-file-ext');
  expect(screen.getByText('1.5 MB')).toHaveClass('media-file-size');
  expect(screen.getByText('Download (1.5 MB)')).toBeInTheDocument();
});

test('offers a PDF as a file plus a preview that opens the viewer', async () => {
  const onOpen = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaContent, {
    props: {
      kind: 'file',
      source: 'mxc://example.org/pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
      onOpen,
    },
  });

  await settle();

  expect(document.querySelector('.pdf-viewer')).not.toBeInTheDocument();
  expect(document.querySelector('a[download="report.pdf"]')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('previews a readable text attachment and leaves an opaque one alone', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{ "hello": "world" }')))
  );

  const previewed = render(MediaContent, {
    props: {
      kind: 'file',
      source: 'mxc://example.org/json',
      mime: 'application/json',
      filename: 'payload.json',
    },
  });

  await settle();

  await settle();

  expect(screen.getByRole('button', { name: 'Open payload.json' })).toHaveTextContent('"hello"');
  previewed.unmount();

  render(MediaContent, {
    props: {
      kind: 'file',
      source: 'mxc://example.org/zip',
      mime: 'application/zip',
      filename: 'archive.zip',
    },
  });

  await settle();

  expect(screen.queryByRole('button', { name: 'Open archive.zip' })).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});

test('renders a voice message with a waveform when a waveform is present', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaContent, {
    props: {
      kind: 'audio',
      source: 'mxc://example.org/voice',
      mime: 'audio/ogg',
      filename: 'Voice message',
      durationMs: 4200,
      waveform: [0, 0.5, 1, 0.5, 0],
    },
  });

  await settle();

  expect(document.querySelector('.voice-message-player')).not.toBeNull();
  expect(document.querySelectorAll('.voice-bar')).toHaveLength(5);
  expect(document.querySelector('audio.media-content')).toBeNull();
});

test('falls back to the plain audio player when there is no waveform', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaContent, {
    props: {
      kind: 'audio',
      source: 'mxc://example.org/audio-no-waveform',
      mime: 'audio/ogg',
      filename: 'clip.ogg',
      waveform: null,
    },
  });

  await settle();

  expect(document.querySelector('.voice-message-player')).toBeNull();
  expect(document.querySelector('audio.media-content')).not.toBeNull();
});

test('labels unavailable attachments', async () => {
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockResolvedValueOnce(new Uint8Array(new ArrayBuffer()));
  render(MediaContent, {
    props: {
      kind: 'file',
      source: 'mxc://example.org/unavailable-file',
      mime: 'application/pdf',
      filename: 'report.pdf',
    },
  });

  await settle();

  expect(screen.getByText(/report\.pdf: Media unavailable/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
  await settle();

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Media unavailable/)).not.toBeInTheDocument();
});

test('shows the download percentage while the original is fetched', async () => {
  const listeners: ((event: CoreEvent) => void)[] = [];
  const subscribe = vi.mocked(
    core.subscribeEvents as unknown as (onEvent: (event: CoreEvent) => void) => () => void
  );
  subscribe.mockImplementation((onEvent) => {
    listeners.push(onEvent);
    return () => {};
  });
  const instance = render(MediaContent, {
    props: { kind: 'file', source: 'mxc://example.org/big', mime: null, filename: 'big.zip' },
  });
  await settle();
  await userEvent.click(screen.getByRole('button', { name: /^Download/ }));
  await settle();

  for (const listener of listeners) {
    listener({ type: 'media_progress', source: 'mxc://example.org/other', current: 9, total: 10 });
    listener({ type: 'media_progress', source: 'mxc://example.org/big', current: 2, total: 5 });
  }
  await tick();

  expect(screen.getByText('40%')).toHaveClass('media-loading-label');
  instance.unmount();
  subscribe.mockImplementation(() => () => {});
});

test('a video shows its thumbnail and waits for play before fetching', async () => {
  render(MediaContent, {
    props: {
      kind: 'video',
      source: 'mxc://example.org/waiting-video',
      thumbnail: 'mxc://example.org/waiting-poster',
      mime: 'video/mp4',
      filename: 'clip.mp4',
      width: 1920,
      height: 1080,
    },
  });

  await settle();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/waiting-poster', 800, 600);
  expect(document.querySelector('.media-poster')).not.toBeNull();
});
