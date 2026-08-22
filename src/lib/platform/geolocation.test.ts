import { afterEach, expect, test, vi } from 'vitest';

import { currentFix, locates } from './geolocation';

const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'geolocation', original);
  else Reflect.deleteProperty(navigator, 'geolocation');
});

function provide(getCurrentPosition: unknown): void {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
}

test('a webview without geolocation reports itself unsupported', async () => {
  Reflect.deleteProperty(navigator, 'geolocation');

  expect(locates()).toBe(false);
  await expect(currentFix()).resolves.toEqual({ kind: 'unsupported' });
});

test('a fix comes back as coordinates', async () => {
  provide((resolve: (position: unknown) => void) => {
    resolve({ coords: { latitude: 48.8584, longitude: 2.2945 } });
  });

  await expect(currentFix()).resolves.toEqual({
    kind: 'fix',
    fix: { latitude: 48.8584, longitude: 2.2945 },
  });
});

test.each([
  ['a refusal', 1, 'denied'],
  ['a failure', 2, 'unavailable'],
])('%s is told apart', async (_name, code, kind) => {
  provide((_resolve: unknown, reject: (error: unknown) => void) => {
    reject({ code, PERMISSION_DENIED: 1 });
  });

  await expect(currentFix()).resolves.toEqual({ kind });
});

test('the request carries a timeout, so a silent provider cannot hang the dialog', async () => {
  const getCurrentPosition = vi.fn((resolve: (position: unknown) => void) => {
    resolve({ coords: { latitude: 0, longitude: 0 } });
  });
  provide(getCurrentPosition);

  await currentFix(1234);

  expect(getCurrentPosition).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    timeout: 1234,
    enableHighAccuracy: false,
  });
});
