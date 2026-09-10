import { afterEach, expect, test, vi } from 'vitest';

const { invoke, osType } = vi.hoisted(() => ({ invoke: vi.fn(), osType: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: osType }));

import { rawInvoke } from './raw-invoke.js';

afterEach(() => {
  invoke.mockReset();
  osType.mockReset();
  vi.unstubAllGlobals();
});

test('sends raw command bodies through Android JSON IPC', async () => {
  vi.stubGlobal('window', {});
  osType.mockReturnValue('android');
  invoke.mockResolvedValue(undefined);

  await rawInvoke('send_attachment', new Uint8Array([0, 1, 255]), { filename: 'été.png' });

  expect(invoke).toHaveBeenCalledWith('send_attachment_base64', {
    bytes: 'AAH/',
    headers: { filename: '%C3%A9t%C3%A9.png' },
  });
});

test('keeps non-attachment raw commands unchanged on Android', async () => {
  vi.stubGlobal('window', {});
  osType.mockReturnValue('android');
  invoke.mockResolvedValue(undefined);

  const bytes = new Uint8Array([0, 1, 255]);
  await rawInvoke('save_media_to_photos', bytes, { filename: 'image.png' });

  expect(invoke).toHaveBeenCalledWith('save_media_to_photos', bytes, {
    headers: { filename: 'image.png' },
  });
});
