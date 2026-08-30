import { expect, test } from 'vitest';

import {
  emoteRoomsEventContent,
  readEmoteRooms,
  selectedAddresses,
  withSelection,
} from './emote-rooms';

test('reads the selection the spec defines and ignores what it cannot', () => {
  const selection = readEmoteRooms({ rooms: { '!a:s': { one: {}, two: {} }, '!b:s': 7 } });

  expect(selectedAddresses(selection)).toEqual([
    { roomId: '!a:s', stateKey: 'one' },
    { roomId: '!a:s', stateKey: 'two' },
  ]);
});

test('an absent event reads as no selection', () => {
  expect(readEmoteRooms(null)).toEqual({});
  expect(readEmoteRooms({})).toEqual({});
});

test('adding a pack keeps the room’s other packs', () => {
  const selection = withSelection(
    readEmoteRooms({ rooms: { '!a:s': { one: {} } } }),
    [{ roomId: '!a:s', stateKey: 'two' }],
    []
  );

  expect(selectedAddresses(selection)).toHaveLength(2);
});

test('adding a pack twice does not duplicate it', () => {
  const selection = withSelection(
    readEmoteRooms({ rooms: { '!a:s': { one: {} } } }),
    [{ roomId: '!a:s', stateKey: 'one' }],
    []
  );

  expect(selectedAddresses(selection)).toEqual([{ roomId: '!a:s', stateKey: 'one' }]);
});

test('removing the last pack drops the room entirely', () => {
  const selection = withSelection(
    readEmoteRooms({ rooms: { '!a:s': { one: {} } } }),
    [],
    [{ roomId: '!a:s', stateKey: 'one' }]
  );

  expect(emoteRoomsEventContent(selection)).toEqual({ rooms: {} });
});

test('a removal wins over an addition of the same pack', () => {
  const address = { roomId: '!a:s', stateKey: 'one' };
  const selection = withSelection({}, [address], [address]);

  expect(selectedAddresses(selection)).toEqual([]);
});
