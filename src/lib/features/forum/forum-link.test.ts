import { expect, test } from 'vitest';

import { resolveForumLink } from './forum-link';

function sources(events: Partial<Record<string, object>>) {
  return (eventId: string) => {
    const content = events[eventId];
    return content === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(JSON.stringify({ event_id: eventId, content }));
  };
}

const threadReply = { body: 'reply', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } };

test('a post opens as its own thread', async () => {
  await expect(resolveForumLink(sources({ $root: { body: 'post' } }), '$root')).resolves.toEqual({
    rootEventId: '$root',
    eventId: '$root',
  });
});

test('a reply opens its thread focused on the reply', async () => {
  await expect(resolveForumLink(sources({ $reply: threadReply }), '$reply')).resolves.toEqual({
    rootEventId: '$root',
    eventId: '$reply',
  });
});

test.each([
  ['m.replace', '$edit'],
  ['m.annotation', '$reaction'],
])('a %s of a reply opens the reply in its thread', async (relType, eventId) => {
  const read = sources({
    $reply: threadReply,
    [eventId]: { 'm.relates_to': { rel_type: relType, event_id: '$reply' } },
  });
  await expect(resolveForumLink(read, eventId)).resolves.toEqual({
    rootEventId: '$root',
    eventId: '$reply',
  });
});

test('an edit of a post opens the post', async () => {
  const read = sources({
    $root: { body: 'post' },
    $edit: { 'm.relates_to': { rel_type: 'm.replace', event_id: '$root' } },
  });
  await expect(resolveForumLink(read, '$edit')).resolves.toEqual({
    rootEventId: '$root',
    eventId: '$root',
  });
});

test('an unreadable event rejects', async () => {
  await expect(resolveForumLink(sources({}), '$missing')).rejects.toThrow('not found');
});
