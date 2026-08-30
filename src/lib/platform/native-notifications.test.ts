import { expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
}));

import { readAction, readTarget } from './native-notifications';

const extra = {
  user_id: '@me:example.org',
  room_id: '!room:example.org',
  event_id: '$event:example.org',
};

test('a target needs an account and a room, and nothing else', () => {
  expect(readTarget(extra)).toEqual({
    userId: '@me:example.org',
    roomId: '!room:example.org',
    eventId: '$event:example.org',
  });
  expect(readTarget({ ...extra, event_id: '' })?.eventId).toBeNull();
  expect(readTarget({ room_id: '!room:example.org' })).toBeNull();
  expect(readTarget(undefined)).toBeNull();
});

test('a reply carries its typed text, trimmed', () => {
  expect(
    readAction({ actionId: 'sable-reply', inputValue: '  on my way  ', notification: { extra } })
  ).toMatchObject({ actionId: 'sable-reply', text: 'on my way', roomId: '!room:example.org' });
});

test('an action without text reports none', () => {
  expect(readAction({ actionId: 'sable-mark-read', notification: { extra } })?.text).toBeNull();
  expect(
    readAction({ actionId: 'sable-reply', inputValue: '   ', notification: { extra } })?.text
  ).toBeNull();
});

test('an action that names no room is not one of ours', () => {
  expect(readAction({ actionId: 'sable-reply', notification: {} })).toBeNull();
  expect(readAction({ notification: { extra } })).toBeNull();
});
