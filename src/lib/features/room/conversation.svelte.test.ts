import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { Conversation } from './conversation.svelte';

const ROOM = '!room:example.org';

function item(eventId: string, sender: string): TimelineItemView {
  return {
    id: eventId,
    event_id: eventId,
    sender,
    sender_name: 'Ana',
    content: { kind: 'message', body: 'Hello', html: '<p>Hello</p>' },
  } as unknown as TimelineItemView;
}

function setup(items: TimelineItemView[], userId: string) {
  const sendMessage = vi.fn(() => Promise.resolve());
  const editMessage = vi.fn(() => Promise.resolve());
  const core = {
    session: { user_id: userId },
    commands: { sendMessage, editMessage },
  } as unknown as CoreClient;
  const personas = {
    personas: [],
    selectionFor: () => null,
    select: () => Promise.resolve(),
  } as unknown as PersonaStore;
  const timeline = { items } as unknown as RoomTimeline;

  return {
    sendMessage,
    editMessage,
    conversation: new Conversation({ core, personas, timeline, roomId: () => ROOM }),
  };
}

test('a reply notifies the author it answers', async () => {
  const { conversation, sendMessage } = setup(
    [item('$one:example.org', '@ana:example.org')],
    '@kris:example.org'
  );

  conversation.reply('$one:example.org');
  expect(conversation.context?.silentReply).toBe(false);

  await conversation.sendMessage(ROOM, 'sure');
  expect(sendMessage).toHaveBeenCalledWith(
    ROOM,
    'sure',
    expect.objectContaining({ inReplyTo: '$one:example.org', silentReply: false })
  );
});

test('muting the reply stops the mention', async () => {
  const { conversation, sendMessage } = setup(
    [item('$one:example.org', '@ana:example.org')],
    '@kris:example.org'
  );

  conversation.reply('$one:example.org');
  conversation.toggleSilentReply();
  expect(conversation.context?.silentReply).toBe(true);

  await conversation.sendMessage(ROOM, 'sure');
  expect(sendMessage).toHaveBeenCalledWith(
    ROOM,
    'sure',
    expect.objectContaining({ silentReply: true })
  );
});

test('replying to yourself never mentions', () => {
  const { conversation } = setup(
    [item('$one:example.org', '@kris:example.org')],
    '@kris:example.org'
  );

  conversation.reply('$one:example.org');
  expect(conversation.context?.silentReply).toBe(true);
});

test('editing a pending message uses its transaction ID', async () => {
  const pending = {
    ...item('local-id', '@kris:example.org'),
    event_id: null,
    transaction_id: 'transaction-1',
  };
  const { conversation, editMessage } = setup([pending], '@kris:example.org');
  conversation.editLast();
  await conversation.sendMessage(ROOM, 'corrected');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    null,
    'corrected',
    expect.objectContaining({ transactionId: 'transaction-1' })
  );
});

test('an edit still targets its event after the item leaves the visible timeline', async () => {
  const { conversation, editMessage } = setup([], '@kris:example.org');
  conversation.edit('$original', 'before');
  await conversation.sendMessage(ROOM, 'after');
  expect(editMessage).toHaveBeenCalledWith(ROOM, '$original', 'after', expect.anything());
});

test('a pending edit follows its stable timeline ID after sync drops the transaction ID', async () => {
  const pending = {
    ...item('local-id', '@kris:example.org'),
    event_id: null,
    transaction_id: 'transaction-1',
  };
  const items: TimelineItemView[] = [pending];
  const { conversation, editMessage } = setup(items, '@kris:example.org');
  conversation.editLast();
  items[0] = { ...pending, event_id: '$sent', transaction_id: null };
  await conversation.sendMessage(ROOM, 'corrected');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    '$sent',
    'corrected',
    expect.objectContaining({ transactionId: null })
  );
});
