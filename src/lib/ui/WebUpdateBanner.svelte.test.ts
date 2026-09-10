// @vitest-environment happy-dom

import { version } from '$app/env';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import WebUpdateBanner from './WebUpdateBanner.svelte';

vi.mock('$app/env', () => ({ version: 'build-two' }));

function answering(reported: string | null) {
  return vi.fn((message: { type: string }, transfer?: Transferable[]) => {
    if (message.type !== 'sable:version') return;
    const port = transfer?.[0] as MessagePort | undefined;
    if (reported !== null) port?.postMessage(reported);
  });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
  await tick();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('offers to refresh when a worker is waiting', async () => {
  const postMessage = answering('older-build');
  const reload = vi.fn();
  const registration = Object.assign(new EventTarget(), {
    waiting: { postMessage },
    update: vi.fn(() => Promise.resolve()),
  }) as unknown as ServiceWorkerRegistration;
  const serviceWorker = Object.assign(new EventTarget(), { ready: Promise.resolve(registration) });
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('location', { reload });

  const instance = mount(WebUpdateBanner, { target: document.body });
  await settle();

  document.querySelector<HTMLButtonElement>('.btn-primary')?.click();

  expect(postMessage).toHaveBeenCalledWith({ type: 'sable:skip-waiting' });
  expect(reload).not.toHaveBeenCalled();

  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledOnce();
  await unmount(instance);
});

test('activates a worker built from the same version without prompting', async () => {
  const postMessage = answering(version);
  const registration = Object.assign(new EventTarget(), {
    waiting: { postMessage },
    update: vi.fn(() => Promise.resolve()),
  }) as unknown as ServiceWorkerRegistration;
  const serviceWorker = Object.assign(new EventTarget(), { ready: Promise.resolve(registration) });
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('location', { reload: vi.fn() });

  const instance = mount(WebUpdateBanner, { target: document.body });
  await settle();

  expect(document.querySelector('.btn-primary')).toBeNull();
  expect(postMessage).toHaveBeenCalledWith({ type: 'sable:skip-waiting' });
  await unmount(instance);
});
