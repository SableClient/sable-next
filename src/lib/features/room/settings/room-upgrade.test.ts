import { expect, test } from 'vitest';

import { additionalCreatorsSupported, readCreate, readTombstone } from './room-upgrade';

test('additional creators arrived in room version 12', () => {
  expect(additionalCreatorsSupported('11')).toBe(false);
  expect(additionalCreatorsSupported('12')).toBe(true);
  expect(additionalCreatorsSupported('org.matrix.msc4289.12')).toBe(true);
  expect(additionalCreatorsSupported('')).toBe(false);
});

test('a create event yields its version and predecessor', () => {
  expect(readCreate({ room_version: '10', predecessor: { room_id: '!old:example.org' } })).toEqual({
    version: '10',
    predecessor: '!old:example.org',
  });
});

test('a create event without a version is version 1', () => {
  expect(readCreate({})).toEqual({ version: '1', predecessor: null });
  expect(readCreate(null)).toEqual({ version: '1', predecessor: null });
  expect(readCreate('nonsense')).toEqual({ version: '1', predecessor: null });
});

test('a tombstone yields its replacement and message', () => {
  expect(readTombstone({ replacement_room: '!new:example.org', body: 'Moved' })).toEqual({
    replacement: '!new:example.org',
    body: 'Moved',
  });
});

test('an empty tombstone body falls back to nothing, not an empty line', () => {
  expect(readTombstone({ replacement_room: '!new:example.org', body: '' })).toEqual({
    replacement: '!new:example.org',
    body: null,
  });
});

test('a room with no tombstone has not been replaced', () => {
  expect(readTombstone(null)).toEqual({ replacement: null, body: null });
});
