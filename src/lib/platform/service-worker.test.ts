// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isTauri: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return import('./service-worker');
}

test('the shells register nothing and wait for nothing', async () => {
  mocks.isTauri.mockReturnValue(true);
  const register = vi.fn();
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: new Promise<never>(() => undefined) },
  });

  const { activeServiceWorker, hostsServiceWorker } = await load();

  expect(hostsServiceWorker()).toBe(false);
  await expect(activeServiceWorker()).resolves.toBeUndefined();
  expect(register).not.toHaveBeenCalled();
});

test('the push path waits for the registration the layout has not made yet', async () => {
  mocks.isTauri.mockReturnValue(false);
  const registration = { scope: '/' } as ServiceWorkerRegistration;
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: Promise.resolve(registration) },
  });

  const { activeServiceWorker } = await load();

  await expect(activeServiceWorker()).resolves.toBe(registration);
  expect(register).toHaveBeenCalledOnce();
});

test('a failed registration resolves rather than hanging on ready', async () => {
  mocks.isTauri.mockReturnValue(false);
  const register = vi.fn().mockRejectedValue(new Error('boom'));
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: new Promise<never>(() => undefined) },
  });

  const { activeServiceWorker } = await load();

  await expect(activeServiceWorker()).resolves.toBeUndefined();
});

test('concurrent callers share one registration', async () => {
  mocks.isTauri.mockReturnValue(false);
  const registration = { scope: '/' } as ServiceWorkerRegistration;
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: Promise.resolve(registration) },
  });

  const { activeServiceWorker, registerServiceWorker } = await load();

  await Promise.all([registerServiceWorker(), activeServiceWorker(), activeServiceWorker()]);

  expect(register).toHaveBeenCalledOnce();
});
