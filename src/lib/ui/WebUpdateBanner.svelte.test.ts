// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import WebUpdateBanner from './WebUpdateBanner.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('offers to refresh when a worker is waiting', async () => {
  const postMessage = vi.fn();
  const reload = vi.fn();
  const registration = Object.assign(new EventTarget(), {
    waiting: { postMessage },
    update: vi.fn(() => Promise.resolve()),
  }) as unknown as ServiceWorkerRegistration;
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve(registration) } });
  vi.stubGlobal('location', { reload });

  const instance = mount(WebUpdateBanner, { target: document.body });
  await Promise.resolve();
  await tick();

  document.querySelector<HTMLButtonElement>('.sable-button-primary')?.click();

  expect(postMessage).toHaveBeenCalledWith({ type: 'sable:skip-waiting' });
  expect(reload).toHaveBeenCalledOnce();
  await unmount(instance);
});
