import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { ReplyFallback, RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { adoptQueue, scheduledQueue } from '#lib/features/composer/scheduled-queue.svelte.js';
import { ScheduledOriginalKept } from '#lib/features/composer/send-failure.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

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

function setup(items: TimelineItemView[], userId: string, store: Partial<PersonaStore> = {}) {
  const sendMessage = vi.fn(() => Promise.resolve());
  const editMessage = vi.fn(() => Promise.resolve());
  const core = {
    session: { user_id: userId },
    commands: { sendMessage, editMessage },
  } as unknown as CoreClient;
  const personas = {
    personas: [],
    selectionFor: () => null,
    disabledIn: () => false,
    select: () => Promise.resolve(),
    ...store,
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

function encryptedScheduleFailure(): Error {
  const error = new Error('encrypted');
  Object.assign(error, { detail: { code: 'encrypted_schedule_unsupported' } });
  return error;
}

test('personas off in a room ignore the selection and proxy triggers', async () => {
  setPreference('personaProxying', true);
  const kris = {
    id: 'kris',
    display_name: 'Kris',
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    triggers: [{ prefix: 'k:', suffix: null, keep_trigger: false }],
    pluralkit: null,
  };
  const select = vi.fn(() => Promise.resolve());
  const { conversation, sendMessage } = setup([], '@kris:example.org', {
    personas: [kris],
    selectionFor: (roomId) => (roomId === null ? { persona_id: 'kris', valid_until: null } : null),
    disabledIn: (roomId) => roomId === ROOM,
    select,
  });

  await conversation.sendMessage(ROOM, 'k:!help');

  expect(sendMessage).toHaveBeenCalledWith(
    ROOM,
    'k:!help',
    expect.objectContaining({ persona: null })
  );
  expect(select).not.toHaveBeenCalled();
});

function scheduling() {
  const scheduleMessage = vi.fn(() => Promise.reject(encryptedScheduleFailure()));
  const core = {
    session: { user_id: '@kris:example.org', device_id: 'DEV' },
    commands: { scheduleMessage },
  } as unknown as CoreClient;

  return new Conversation({
    core,
    personas: { personas: [] } as unknown as PersonaStore,
    timeline: { items: [] } as unknown as RoomTimeline,
    roomId: () => ROOM,
    encrypted: () => true,
  });
}

afterEach(() => {
  adoptQueue([]);
  setPreference('scheduleInEncryptedRooms', true);
  setPreference('personaProxying', false);
});

test('an encrypted room falls back to the local queue while the preference allows it', async () => {
  await scheduling().schedule(ROOM, 'later', null, Date.now() + 60_000);

  expect(scheduledQueue()).toHaveLength(1);
});

test('with the preference off an encrypted room refuses the schedule instead of queueing it', async () => {
  setPreference('scheduleInEncryptedRooms', false);

  await expect(scheduling().schedule(ROOM, 'later', null, Date.now() + 60_000)).rejects.toThrow(
    'encrypted'
  );
  expect(scheduledQueue()).toHaveLength(0);
});

function rescheduling(
  scheduleMessage: () => Promise<unknown> = () => Promise.resolve('$new'),
  cancelScheduledMessage: () => Promise<unknown> = () => Promise.resolve()
) {
  const calls: string[] = [];
  const schedule = vi.fn(() => {
    calls.push('schedule');
    return scheduleMessage();
  });
  const cancel = vi.fn((_delayId: string) => {
    calls.push('cancel');
    return cancelScheduledMessage();
  });
  const core = {
    session: { user_id: '@kris:example.org', device_id: 'DEV' },
    commands: { scheduleMessage: schedule, cancelScheduledMessage: cancel },
  } as unknown as CoreClient;
  const conversation = new Conversation({
    core,
    personas: { personas: [] } as unknown as PersonaStore,
    timeline: { items: [] } as unknown as RoomTimeline,
    roomId: () => ROOM,
  });

  return { conversation, schedule, cancel, calls };
}

test('saving an edited server-side schedule books the new one before cancelling the old', async () => {
  const { conversation, cancel, calls } = rescheduling();
  const dueTs = Date.now() + 60_000;
  conversation.editScheduled('old', 'typo', null, { source: 'server', dueTs });

  await conversation.schedule(ROOM, 'fixed', null, dueTs + 60_000);

  expect(calls).toEqual(['schedule', 'cancel']);
  expect(cancel).toHaveBeenCalledWith('old');
  expect(conversation.context).toBeNull();
  expect(conversation.scheduledRevision).toBe(1);
});

test('a failed reschedule keeps the original and the edit', async () => {
  const { conversation, cancel } = rescheduling(() => Promise.reject(new Error('offline')));
  conversation.editScheduled('old', 'typo', null, { source: 'server', dueTs: null });

  await expect(conversation.schedule(ROOM, 'fixed', null, Date.now() + 60_000)).rejects.toThrow(
    'offline'
  );

  expect(cancel).not.toHaveBeenCalled();
  expect(conversation.context?.kind).toBe('schedule');
});

test('an original that cannot be cancelled is reported, not dropped silently', async () => {
  const { conversation, schedule } = rescheduling(undefined, () =>
    Promise.reject(new Error('gone'))
  );
  conversation.editScheduled('old', 'typo', null, { source: 'server', dueTs: null });

  await expect(
    conversation.schedule(ROOM, 'fixed', null, Date.now() + 60_000)
  ).rejects.toBeInstanceOf(ScheduledOriginalKept);

  expect(schedule).toHaveBeenCalledOnce();
  expect(conversation.context).toBeNull();
  expect(conversation.scheduledRevision).toBe(1);
});

test('saving an edited queued message replaces its queue entry', async () => {
  const conversation = scheduling();
  const dueTs = Date.now() + 60_000;
  adoptQueue([{ id: 'old', roomId: ROOM, body: 'typo', formatted: null, dueTs, owner: 'DEV' }]);
  conversation.editScheduled('old', 'typo', null, { source: 'queue', dueTs });

  await conversation.schedule(ROOM, 'fixed', '<b>fixed</b>', dueTs + 60_000);

  expect(scheduledQueue()).toEqual([
    expect.objectContaining({ body: 'fixed', formatted: '<b>fixed</b>', dueTs: dueTs + 60_000 }),
  ]);
  expect(conversation.context).toBeNull();
});

test('a reply the SDK cannot embed takes its preview from the event source', async () => {
  const reply = {
    ...item('$reply:example.org', '@kris:example.org'),
    in_reply_to: { event_id: '$reaction:example.org', sender: null, body: null },
  } as unknown as TimelineItemView;
  const provideReplyFallback = vi.fn<(eventId: string, fallback: ReplyFallback) => void>();
  const eventSource = vi.fn(() =>
    Promise.resolve(
      JSON.stringify({
        type: 'm.reaction',
        sender: '@ana:example.org',
        content: { 'm.relates_to': { key: '🎉' } },
      })
    )
  );
  const core = {
    session: { user_id: '@kris:example.org' },
    commands: {
      fetchEventDetails: vi.fn(() => Promise.reject(new Error('unsupported'))),
      eventSource,
    },
  } as unknown as CoreClient;
  const timeline = { items: [reply], provideReplyFallback } as unknown as RoomTimeline;
  const conversation = new Conversation({
    core,
    personas: {} as PersonaStore,
    timeline,
    roomId: () => ROOM,
  });

  conversation.fetchMissingReplyDetails();
  await vi.waitFor(() => {
    expect(provideReplyFallback).toHaveBeenCalled();
  });

  expect(eventSource).toHaveBeenCalledWith(ROOM, '$reaction:example.org');
  const [eventId, fallback] = provideReplyFallback.mock.calls[0];
  expect(eventId).toBe('$reaction:example.org');
  expect(fallback.sender).toBe('@ana:example.org');
  expect(fallback.body).toContain('🎉');
});
