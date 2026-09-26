import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(): Promise<typeof import('./persistent-storage')> {
  return import('./persistent-storage');
}

test('asks the browser once and reuses the answer', async () => {
  const persist = vi.fn(() => Promise.resolve(true));
  vi.stubGlobal('navigator', {
    storage: { persisted: vi.fn(() => Promise.resolve(false)), persist },
  });
  const { keepStorage } = await load();

  expect(await keepStorage()).toBe(true);
  expect(await keepStorage()).toBe(true);
  expect(persist).toHaveBeenCalledTimes(1);
});

test('does not ask again when storage is already persistent', async () => {
  const persist = vi.fn(() => Promise.resolve(true));
  vi.stubGlobal('navigator', {
    storage: { persisted: vi.fn(() => Promise.resolve(true)), persist },
  });
  const { keepStorage } = await load();

  expect(await keepStorage()).toBe(true);
  expect(persist).not.toHaveBeenCalled();
});

test('a browser without the storage API reports false', async () => {
  vi.stubGlobal('navigator', {});
  const { keepStorage } = await load();

  expect(await keepStorage()).toBe(false);
});
