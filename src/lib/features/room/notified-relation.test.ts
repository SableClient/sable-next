import { expect, test } from 'vitest';

import { notifiedRelation } from './notified-relation';

const source = (relation: unknown) =>
  JSON.stringify({ type: 'm.room.message', content: { body: 'hi', 'm.relates_to': relation } });

test('a thread reply lands on its root and opens the thread', () => {
  expect(notifiedRelation(source({ rel_type: 'm.thread', event_id: '$root' }))).toEqual({
    eventId: '$root',
    thread: true,
  });
});

test('an edit or a reaction lands on the message it changed', () => {
  expect(notifiedRelation(source({ rel_type: 'm.replace', event_id: '$original' }))).toEqual({
    eventId: '$original',
    thread: false,
  });
  expect(notifiedRelation(source({ rel_type: 'm.annotation', event_id: '$liked' }))).toEqual({
    eventId: '$liked',
    thread: false,
  });
});

test('a plain reply and an unrelated event keep their own row', () => {
  expect(notifiedRelation(source({ 'm.in_reply_to': { event_id: '$quoted' } }))).toBeNull();
  expect(notifiedRelation(JSON.stringify({ type: 'm.room.message', content: {} }))).toBeNull();
  expect(notifiedRelation('not json')).toBeNull();
});
