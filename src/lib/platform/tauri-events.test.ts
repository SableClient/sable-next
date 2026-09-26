import { afterEach, expect, test, vi } from 'vitest';

import { tolerateUnknownListeners } from './tauri-events.js';

type Internals = { unregisterListener: (event: string, eventId: number) => void };
const host = globalThis as { window?: { __TAURI_EVENT_PLUGIN_INTERNALS__?: Internals } };

afterEach(() => {
  delete host.window;
});

test('an unknown listener id no longer throws out of unlisten', () => {
  const unregister = vi.fn(() => {
    throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
  });
  const internals: Internals = { unregisterListener: unregister };
  host.window = { __TAURI_EVENT_PLUGIN_INTERNALS__: internals };

  tolerateUnknownListeners();

  expect(() => {
    internals.unregisterListener('deep-link://new-url', 7);
  }).not.toThrow();
  expect(unregister).toHaveBeenCalledWith('deep-link://new-url', 7);
});

test('outside Tauri it does nothing', () => {
  host.window = {};
  expect(() => {
    tolerateUnknownListeners();
  }).not.toThrow();
});
