// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { flushed } from '#lib/ui/flushed.js';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { CoreError } from '#src/transport';

import MediaImage from './MediaImage.svelte';

const connection = $state<{ sync: { state: string } | null }>({ sync: { state: 'offline' } });
Object.defineProperty(core, 'sync', { get: () => connection.sync, configurable: true });

afterEach(() => {
  vi.useRealTimers();
  core.fetchMedia.mockReset();
  connection.sync = { state: 'offline' };
  vi.restoreAllMocks();
});

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushed();
}

test('a server that keeps failing is still retried after the first six attempts', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new CoreError({ code: 'unavailable' }));
  render(MediaImage, {
    source: 'mxc://example.org/keeps-failing',
    alt: 'A',
    width: 48,
    height: 48,
  });
  await advance(0);

  await advance(20 * 60_000);

  expect(core.fetchMedia.mock.calls.length).toBeGreaterThan(7);
});

test('media the server does not have is not retried automatically', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new CoreError({ code: 'media_not_found' }));
  render(MediaImage, { source: 'mxc://example.org/gone', alt: 'A', width: 48, height: 48 });
  await advance(0);

  await advance(20 * 60_000);

  expect(core.fetchMedia).toHaveBeenCalledOnce();
});

test('a refused server is asked again only once its wait is over', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValueOnce(
    new CoreError({ code: 'media_server_unavailable', retry_after_ms: 60_000 })
  );
  render(MediaImage, { source: 'mxc://example.org/refused', alt: 'A', width: 48, height: 48 });
  await advance(0);
  core.fetchMedia.mockReturnValue(new Promise(() => {}));

  await advance(59_000);
  expect(core.fetchMedia).toHaveBeenCalledOnce();

  await advance(2_000);
  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
});

async function failOffline(source: string): Promise<number> {
  core.fetchMedia.mockRejectedValue(new Error('offline'));
  render(MediaImage, { source, alt: 'Space', width: 48, height: 48 });
  await vi.waitFor(() => {
    expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  });
  return core.fetchMedia.mock.calls.length;
}

test('an image that failed while offline loads once sync is live', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const failedCalls = await failOffline('mxc://example.org/space-icon-offline');

  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:space-icon');
  connection.sync = { state: 'live' };
  await flushed();

  await vi.waitFor(() => {
    expect(core.fetchMedia.mock.calls.length).toBeGreaterThan(failedCalls);
    expect(screen.getByAltText('Space').getAttribute('src')).toBe('blob:space-icon');
  });
});

test('the failed state stays up while the reconnect retry is in flight', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const failedCalls = await failOffline('mxc://example.org/space-icon-pending');

  core.fetchMedia.mockReturnValue(new Promise(() => {}));
  connection.sync = { state: 'live' };
  await vi.waitFor(() => {
    expect(core.fetchMedia.mock.calls.length).toBeGreaterThan(failedCalls);
  });
  await flushed();

  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
});
