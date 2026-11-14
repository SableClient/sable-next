import { expect, test } from 'vitest';

import { parseWorkerMessage } from './worker-message';

test('unknown messages are dropped', () => {
  expect(parseWorkerMessage(undefined)).toBeNull();
  expect(parseWorkerMessage('sable:open-room')).toBeNull();
  expect(parseWorkerMessage({ type: 'sable:unknown' })).toBeNull();
});

test('opening a room needs a room id', () => {
  expect(parseWorkerMessage({ type: 'sable:open-room', roomId: '!a:b' })).toEqual({
    type: 'sable:open-room',
    roomId: '!a:b',
    userId: null,
    eventId: null,
  });
  expect(parseWorkerMessage({ type: 'sable:open-room' })).toBeNull();
});

test('call and invite actions need a room, a user and a valid outcome', () => {
  const call = { type: 'sable:call-action', roomId: '!a:b', userId: '@me:b', outcome: 'answer' };
  expect(parseWorkerMessage(call)).toEqual({ ...call, eventId: null });
  expect(parseWorkerMessage({ ...call, outcome: 'accept' })).toBeNull();
  expect(parseWorkerMessage({ ...call, userId: undefined })).toBeNull();

  const invite = {
    type: 'sable:invite-action',
    roomId: '!a:b',
    userId: '@me:b',
    outcome: 'accept',
  };
  expect(parseWorkerMessage(invite)).toEqual(invite);
  expect(parseWorkerMessage({ ...invite, outcome: 'answer' })).toBeNull();
});

test('a push acknowledgement needs its token', () => {
  expect(parseWorkerMessage({ type: 'sable:webpush-ack', appId: 'app' })).toBeNull();
  expect(parseWorkerMessage({ type: 'sable:webpush-ack', appId: 'app', ackToken: 't' })).toEqual({
    type: 'sable:webpush-ack',
    appId: 'app',
    ackToken: 't',
  });
});

test('a push event needs its room, event and account', () => {
  const push = { type: 'sable:push-event', roomId: '!a:b', eventId: '$e', userId: '@me:b' };
  expect(parseWorkerMessage(push)).toEqual({ ...push, serverUserId: null });
  expect(parseWorkerMessage({ ...push, eventId: undefined })).toBeNull();
});

test('shared content keeps only real files', () => {
  const file = new File(['a'], 'a.txt');
  expect(parseWorkerMessage({ type: 'sable:share', files: [file, 'not a file'] })).toMatchObject({
    files: [file],
  });
});

test('shared content defaults to no text and no files', () => {
  expect(parseWorkerMessage({ type: 'sable:share' })).toEqual({
    type: 'sable:share',
    serverUserId: null,
    text: '',
    files: [],
  });
});
