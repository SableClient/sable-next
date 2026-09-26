import { expect, test } from 'vitest';

import {
  appendPushEntry,
  isDiagnosticPush,
  PUSH_HISTORY_LIMIT,
  pushTrace,
  readPushHistory,
} from './push-history';

test('the history keeps only the newest entries', () => {
  let history = readPushHistory(undefined);
  for (let index = 0; index < PUSH_HISTORY_LIMIT + 3; index += 1) {
    history = appendPushEntry(history, { at: index, outcome: 'POSTED' });
  }

  expect(history).toHaveLength(PUSH_HISTORY_LIMIT);
  expect(history[0]?.at).toBe(3);
  expect(history.at(-1)?.at).toBe(PUSH_HISTORY_LIMIT + 2);
});

test('what a store hands back is validated entry by entry', () => {
  expect(
    readPushHistory([
      { at: 1, outcome: 'POSTED', roomId: '!r:x', eventId: '' },
      { at: 'yesterday', outcome: 'POSTED' },
      { at: 2 },
      null,
      { at: 3, outcome: 'DISCARDED', userId: 7 },
    ])
  ).toEqual([
    { at: 1, outcome: 'POSTED', roomId: '!r:x' },
    { at: 3, outcome: 'DISCARDED' },
  ]);
  expect(readPushHistory('not a list')).toEqual([]);
});

test('a diagnostic push is recognised by its event id', () => {
  expect(
    isDiagnosticPush({ notification: { event_id: '$sable-diagnostic-1', room_id: '!r:x' } })
  ).toBe(true);
  expect(isDiagnosticPush({ notification: { event_id: '$real', room_id: '!r:x' } })).toBe(false);
  expect(isDiagnosticPush({})).toBe(false);
});

test('a trace names only what the push carried', () => {
  expect(pushTrace({ notification: { room_id: '!r:x', event_id: '$e' } })).toEqual({
    roomId: '!r:x',
    eventId: '$e',
  });
  expect(pushTrace(undefined)).toEqual({});
});
