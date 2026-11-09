// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest';

const osType = vi.hoisted(() => vi.fn<() => string>());

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: osType }));

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

let agent: MockInstance<() => string>;
let reported: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetModules();
  agent = vi.spyOn(navigator, 'userAgent', 'get');
  reported = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  agent.mockRestore();
  reported.mockRestore();
});

test('the OS plugin decides the platform when it is there', async () => {
  osType.mockReturnValue('android');
  const os = await import('./os');

  expect(os.isNativeMobile()).toBe(true);
  expect(os.isAndroid()).toBe(true);
  expect(reported).not.toHaveBeenCalled();
});

test('a missing OS plugin falls back to the user agent and is reported once', async () => {
  osType.mockImplementation(() => {
    throw new TypeError(
      "undefined is not an object (evaluating 'window.__TAURI_OS_PLUGIN_INTERNALS__.os_type')"
    );
  });
  agent.mockReturnValue(IPHONE);
  const os = await import('./os');

  expect(os.isIos()).toBe(true);
  expect(os.isNativeMobile()).toBe(true);
  expect(reported).toHaveBeenCalledOnce();
  expect(reported).toHaveBeenCalledWith(
    '[sable platform] OS plugin unavailable, using the user agent',
    'ios',
    expect.any(TypeError)
  );
});
