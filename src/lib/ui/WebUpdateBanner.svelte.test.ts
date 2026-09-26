// @vitest-environment happy-dom

import { version } from '$app/env';
import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
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

  const user = userEvent.setup();
  render(WebUpdateBanner);
  await settle();

  await user.click(screen.getByRole('button', { name: 'Refresh' }));

  expect(postMessage).toHaveBeenCalledWith({ type: 'sable:skip-waiting' });
  expect(reload).not.toHaveBeenCalled();

  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledOnce();
});

test('keeps checking for a new worker while the tab stays open', async () => {
  vi.useFakeTimers();
  const update = vi.fn(() => Promise.resolve());
  const registration = Object.assign(new EventTarget(), {
    update,
  }) as unknown as ServiceWorkerRegistration;
  const serviceWorker = Object.assign(new EventTarget(), { ready: Promise.resolve(registration) });
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('location', { reload: vi.fn() });

  const instance = render(WebUpdateBanner);
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(600_000);
  expect(update).toHaveBeenCalledTimes(3);

  instance.unmount();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(update).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
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

  render(WebUpdateBanner);
  await settle();

  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(postMessage).toHaveBeenCalledWith({ type: 'sable:skip-waiting' });
});
