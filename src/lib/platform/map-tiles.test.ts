import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  convertFileSrc: vi.fn(
    (path: string, scheme: string) => `${scheme}://localhost/${encodeURIComponent(path)}`
  ),
}));

vi.mock('@tauri-apps/api/core', () => core);

import { tileUrl } from './map-tiles';

afterEach(() => {
  vi.clearAllMocks();
});

test('the browser takes the tiles straight from openstreetmap', () => {
  core.isTauri.mockReturnValue(false);

  expect(tileUrl()).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
});

test("a webview goes through the native scheme with leaflet's placeholders intact", () => {
  core.isTauri.mockReturnValue(true);

  expect(tileUrl()).toBe('sable-tiles://localhost/{z}/{x}/{y}.png');
});
