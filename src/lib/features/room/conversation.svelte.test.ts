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
  const core = {
    session: { user_id: userId },
    commands: { sendMessage },
  } as unknown as CoreClient;
  const personas = {
    personas: [],
    selectionFor: () => null,
    select: () => Promise.resolve(),
  } as unknown as PersonaStore;
  const timeline = { items } as unknown as RoomTimeline;

  return {
    sendMessage,
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
