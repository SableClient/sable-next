import { expect, test } from 'vitest';

import { isLivekitConnectionTimeout, isLivekitMissingKey } from './sentry-event';

test('drops the console error livekit writes for a missing call key', () => {
  expect(
    isLivekitMissingKey({
      exception: {
        values: [
          { type: 'MissingKey', mechanism: { type: 'auto.core.capture_console', handled: true } },
        ],
      },
    })
  ).toBe(true);
  expect(
    isLivekitMissingKey({
      exception: {
        values: [
          {
            value: 'MissingKey: missing key at index 2 for participant @alice:example.test',
            mechanism: { type: 'auto.core.capture_console', handled: true, synthetic: true },
          },
        ],
      },
    })
  ).toBe(true);
});

test('keeps other console errors and other mechanisms', () => {
  expect(
    isLivekitMissingKey({
      exception: {
        values: [
          { type: 'Error', mechanism: { type: 'auto.core.capture_console', handled: true } },
        ],
      },
    })
  ).toBe(false);
  expect(isLivekitMissingKey({ exception: { values: [{ type: 'MissingKey' }] } })).toBe(false);
  expect(isLivekitMissingKey({})).toBe(false);
});

test('drops the console error livekit writes when a reconnect attempt times out', () => {
  const capture = { type: 'auto.core.capture_console', handled: true };
  expect(
    isLivekitConnectionTimeout({
      exception: {
        values: [
          { value: 'room connection has timed out (signal) [object Object]', mechanism: capture },
        ],
      },
    })
  ).toBe(true);
  expect(
    isLivekitConnectionTimeout({
      exception: {
        values: [{ value: 'requested room does not exist [object Object]', mechanism: capture }],
      },
    })
  ).toBe(false);
  expect(
    isLivekitConnectionTimeout({
      exception: { values: [{ value: 'room connection has timed out (signal)' }] },
    })
  ).toBe(false);
});
