import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  osType: vi.fn(() => 'linux'),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getCurrentPosition: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }));
vi.mock('@tauri-apps/plugin-geolocation', () => ({
  checkPermissions: mocks.checkPermissions,
  requestPermissions: mocks.requestPermissions,
  getCurrentPosition: mocks.getCurrentPosition,
}));

import { currentFix, locates } from './geolocation';

const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'geolocation', original);
  else Reflect.deleteProperty(navigator, 'geolocation');
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
  mocks.osType.mockReturnValue('linux');
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

test('a desktop webview reports itself unsupported, whatever navigator claims', async () => {
  provide(() => {});
  mocks.isTauri.mockReturnValue(true);

  expect(locates()).toBe(false);
  await expect(currentFix()).resolves.toEqual({ kind: 'unsupported' });
});

test('a phone takes the fix from the native plugin, prompting once', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  mocks.checkPermissions.mockResolvedValue({ location: 'prompt' });
  mocks.requestPermissions.mockResolvedValue({ location: 'granted' });
  mocks.getCurrentPosition.mockResolvedValue({ coords: { latitude: 1.5, longitude: -2.5 } });

  expect(locates()).toBe(true);
  await expect(currentFix()).resolves.toEqual({
    kind: 'fix',
    fix: { latitude: 1.5, longitude: -2.5 },
  });
  expect(mocks.requestPermissions).toHaveBeenCalledWith(['location']);
});

test('a refused native permission is told apart from a failure', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('ios');
  mocks.checkPermissions.mockResolvedValue({ location: 'denied' });

  await expect(currentFix()).resolves.toEqual({ kind: 'denied' });
  expect(mocks.getCurrentPosition).not.toHaveBeenCalled();

  mocks.checkPermissions.mockResolvedValue({ location: 'granted' });
  mocks.getCurrentPosition.mockRejectedValue(new Error('no provider'));

  await expect(currentFix()).resolves.toEqual({ kind: 'unavailable' });
});
