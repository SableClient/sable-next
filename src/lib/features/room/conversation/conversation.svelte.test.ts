// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { ReplyFallback, RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { adoptQueue, scheduledQueue } from '#lib/features/composer/scheduled-queue.svelte.js';
import { ScheduledOriginalKept } from '#lib/features/composer/send-failure.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import * as runtime from '#lib/config/runtime-config.js';

import { Conversation } from './conversation.svelte';

const ROOM = '!room:example.org';

function item(eventId: string, sender: string): TimelineItemView {
  return {
    id: eventId,
    event_id: eventId,
    sender,
    sender_name: 'Ana',
    reactions: [],
    content: { kind: 'message', body: 'Hello', html: '<p>Hello</p>' },
  } as unknown as TimelineItemView;
}

function setup(
  items: TimelineItemView[],
  userId: string,
  store: Partial<PersonaStore> = {},
  beforeSend?: () => Promise<void>,
  threadRoot: string | null = null
) {
  const sendMessage = vi.fn(() => Promise.resolve());
  const editMessage = vi.fn(() => Promise.resolve());
  const sendAttachment = vi.fn(() => Promise.resolve());
  const sendGallery = vi.fn(() => Promise.resolve());
  const sendGif = vi.fn(() => Promise.resolve());
  const sendLocation = vi.fn(() => Promise.resolve());
  const toggleReaction = vi.fn(() => Promise.resolve());
  const core = {
    session: { user_id: userId },
    commands: {
      sendMessage,
      editMessage,
      sendAttachment,
      sendGallery,
      sendGif,
      sendLocation,
      toggleReaction,
    },
  } as unknown as CoreClient;
  const personas = {
    personas: [],
    selectionFor: () => null,
    disabledIn: () => false,
    select: () => Promise.resolve(),
    ...store,
  } as unknown as PersonaStore;
  const timeline = { items, aggregations: [], subscriptionId: 7 } as unknown as RoomTimeline;

  return {
    sendMessage,
    editMessage,
    sendAttachment,
    sendGallery,
    sendGif,
    sendLocation,
    toggleReaction,
    timeline,
    conversation: new Conversation({
      core,
      personas,
      timeline,
      roomId: () => ROOM,
      beforeSend,
      threadRoot,
    }),
  };
}

test('quick reactions resume live before choosing the latest message', async () => {
  const live = Promise.withResolvers<undefined>();
  const fixture = setup(
    [item('$old', '@ana:example.org')],
    '@kris:example.org',
    {},
    () => live.promise
  );
  const reacting = fixture.conversation.quickReact(ROOM, '😂');
  expect(fixture.toggleReaction).not.toHaveBeenCalled();
  fixture.timeline.items = [
    item('$latest', '@ana:example.org'),
    { ...item('$state', '@ana:example.org'), content: { kind: 'state_event' } } as TimelineItemView,
    { ...item('$pending', '@kris:example.org'), event_id: null },
    { ...item('$redacted', '@ana:example.org'), content: { kind: 'redacted', reason: null } },
  ];
  live.resolve(undefined);
  await reacting;
  expect(fixture.toggleReaction).toHaveBeenCalledWith(ROOM, '$latest', '😂', null, null, 7);
  expect(fixture.sendMessage).not.toHaveBeenCalled();
});

test('quick reactions do nothing in an empty room', async () => {
  const fixture = setup([], '@kris:example.org');
  await fixture.conversation.quickReact(ROOM, '😂');
  expect(fixture.toggleReaction).not.toHaveBeenCalled();
});

test.each(['message', 'image', 'sticker', 'unable_to_decrypt'] as const)(
  'quick reactions target the latest %s',
  async (kind) => {
    const latest = {
      ...item('$latest', '@ana:example.org'),
      content: { kind },
    } as TimelineItemView;
    const fixture = setup([item('$old', '@ana:example.org'), latest], '@kris:example.org');
    await fixture.conversation.quickReact(ROOM, '😂');
    expect(fixture.toggleReaction).toHaveBeenCalledWith(ROOM, '$latest', '😂', null, null, 7);
  }
);

test('quick reactions in a thread target its latest message and preserve the source pack', async () => {
  const sourcePack = { room_id: ROOM, state_key: '', shortcode: 'wave', via: ['example.org'] };
  const fixture = setup(
    [item('$root', '@ana:example.org'), item('$reply', '@kris:example.org')],
    '@kris:example.org',
    {},
    undefined,
    '$root'
  );
  await fixture.conversation.quickReact(ROOM, 'mxc://example.org/wave', sourcePack);
  expect(fixture.toggleReaction).toHaveBeenCalledWith(
    ROOM,
    '$reply',
    'mxc://example.org/wave',
    '$root',
    sourcePack,
    7
  );
});

test('toggling an existing custom quick reaction omits its source pack', async () => {
  const key = 'mxc://example.org/wave';
  const sourcePack = { room_id: ROOM, state_key: '', shortcode: 'wave', via: ['example.org'] };
  const latest = {
    ...item('$latest', '@ana:example.org'),
    reactions: [{ key, senders: ['@kris:example.org'] }],
  };
  const fixture = setup([latest], '@kris:example.org');
  await fixture.conversation.quickReact(ROOM, key, sourcePack);
  expect(fixture.toggleReaction).toHaveBeenCalledWith(ROOM, '$latest', key, null, null, 7);
});

test('reaction failures reach the composer', async () => {
  const fixture = setup([item('$latest', '@ana:example.org')], '@kris:example.org');
  fixture.toggleReaction.mockRejectedValueOnce(new Error('offline'));
  await expect(fixture.conversation.quickReact(ROOM, '😂')).rejects.toThrow('offline');
});

test.each(['message', 'attachment'] as const)(
  'switches to live before sending a %s',
  async (kind) => {
    const live = Promise.withResolvers<undefined>();
    const beforeSend = vi.fn(() => live.promise);
    const { conversation, sendMessage, sendAttachment } = setup(
      [],
      '@kris:example.org',
      {},
      beforeSend
    );
    const sending =
      kind === 'message'
        ? conversation.sendMessage(ROOM, 'hello')
        : conversation.sendAttachment(ROOM, new File(['hello'], 'hello.txt'));
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendAttachment).not.toHaveBeenCalled();
    live.resolve(undefined);
    await sending;
    expect(kind === 'message' ? sendMessage : sendAttachment).toHaveBeenCalledTimes(1);
  }
);

test('a failed switch keeps the reply and prevents sending', async () => {
  const beforeSend = () => Promise.reject(new Error('live unavailable'));
  const { conversation, sendMessage } = setup(
    [item('$one', '@ana:example.org')],
    '@kris:example.org',
    {},
    beforeSend
  );
  conversation.reply('$one');
  await expect(conversation.sendMessage(ROOM, 'hello')).rejects.toThrow('live unavailable');
  expect(sendMessage).not.toHaveBeenCalled();
  expect(conversation.context?.eventId).toBe('$one');
});

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

test.each([
  [false, null],
  [true, null],
  [false, '$root'],
  [true, '$root'],
] as const)(
  'media replies preserve silentReply=%s and threadRoot=%s',
  async (silentReply, threadRoot) => {
    vi.spyOn(runtime, 'runtimeConfig').mockResolvedValue(
      runtime.parseRuntimeConfig({ gifs: { proxyUrl: 'gifs.example' } })
    );
    const fixture = setup(
      [item('$one:example.org', '@ana:example.org')],
      '@kris:example.org',
      {},
      undefined,
      threadRoot
    );
    const { conversation } = fixture;
    const file = new File(['picture'], 'picture.png', { type: 'image/png' });
    const mentions = { userIds: ['@bea:example.org'], room: false };

    for (const kind of ['attachment', 'gallery', 'gif', 'location'] as const) {
      conversation.reply('$one:example.org');
      if (silentReply) conversation.toggleSilentReply();
      if (kind === 'attachment') {
        await conversation.sendAttachment(ROOM, file, { mentions });
        expect(fixture.sendAttachment).toHaveBeenLastCalledWith(
          ROOM,
          file,
          expect.objectContaining({
            inReplyTo: '$one:example.org',
            silentReply,
            mentions,
            threadRoot,
          })
        );
      } else if (kind === 'gallery') {
        await conversation.sendGallery(ROOM, [file, file], { mentions });
        expect(fixture.sendGallery).toHaveBeenLastCalledWith(
          ROOM,
          [file, file],
          expect.objectContaining({
            inReplyTo: '$one:example.org',
            silentReply,
            mentions,
            threadRoot,
          })
        );
      } else if (kind === 'gif') {
        await conversation.sendGif(ROOM, {
          id: 'cat',
          title: 'cat',
          mediaUrl: 'https://media.tenor.com/abc123/cat.gif',
          previewUrl: 'https://media.tenor.com/abc123/cat-tiny.gif',
          width: 320,
          height: 240,
          size: 1000,
          mimetype: 'image/gif',
        });
        expect(fixture.sendGif.mock.lastCall).toEqual([
          ROOM,
          expect.any(String),
          'cat.gif',
          320,
          240,
          'image/gif',
          1000,
          '$one:example.org',
          threadRoot,
          null,
          silentReply,
        ]);
      } else {
        await conversation.sendLocation(ROOM, 'here', 'geo:48,2');
        expect(fixture.sendLocation).toHaveBeenLastCalledWith(
          ROOM,
          'here',
          'geo:48,2',
          '$one:example.org',
          threadRoot,
          silentReply
        );
      }
      expect(conversation.context).toBeNull();
    }
  }
);

test('a reply to a persona message names the persona', () => {
  const target = {
    ...item('$one:example.org', '@ana:example.org'),
    per_message_profile: { display_name: 'Ghost' },
  } as unknown as TimelineItemView;
  const { conversation } = setup([target], '@kris:example.org');

  conversation.reply('$one:example.org');
  expect(conversation.context?.sender).toBe('Ghost');
});

test('a visible reaction aggregation can be replied to', () => {
  const reaction = {
    ...item('$reaction:example.org', '@ana:example.org'),
    content: {
      kind: 'hidden_event',
      event_type: 'm.reaction',
      content: { 'm.relates_to': { event_id: '$message:example.org', key: '🎉' } },
      redacts: null,
    },
  } as TimelineItemView;
  const { conversation, timeline } = setup([], '@kris:example.org');
  timeline.aggregations = [reaction];

  conversation.reply('$reaction:example.org');

  expect(conversation.context).toMatchObject({
    kind: 'reply',
    eventId: '$reaction:example.org',
    sender: 'Ana',
    body: 'm.reaction',
  });
});

test('a reply keeps the target formatting for its composer preview', () => {
  const target = item('$one:example.org', '@ana:example.org');
  target.content = {
    kind: 'message',
    body: ':rotate:',
    html: '<img data-mx-emoticon src="mxc://example.org/rotate" alt=":rotate:">',
    emote: false,
    notice: false,
    edited: false,
  };
  const { conversation } = setup([target], '@kris:example.org');

  conversation.reply('$one:example.org');

  expect(conversation.context).toMatchObject({
    body: ':rotate:',
    html: '<img data-mx-emoticon src="mxc://example.org/rotate" alt=":rotate:">',
  });
});

test('a reply context uses rendered preview text', () => {
  const target = item('$one:example.org', '@ana:example.org');
  target.content = {
    kind: 'message',
    body: '**bold** and ``code ` tick``',
    html: '<strong>bold</strong> and <code>code ` tick</code>',
    emote: false,
    notice: false,
    edited: false,
  };
  const { conversation } = setup([target], '@kris:example.org');
  conversation.reply('$one:example.org');
  expect(conversation.context).toMatchObject({
    body: 'bold and code ` tick',
    html: '<strong>bold</strong> and <code>code ` tick</code>',
  });
});

test('a reply to an earlier version targets the edit and quotes its text', async () => {
  const { conversation, sendMessage } = setup(
    [item('$one:example.org', '@ana:example.org')],
    '@kris:example.org'
  );

  conversation.reply('$edit:example.org', {
    of: '$one:example.org',
    body: 'Helo',
    html: '<em>Helo</em>',
  });
  expect(conversation.context).toMatchObject({
    kind: 'reply',
    eventId: '$edit:example.org',
    sender: 'Ana',
    body: 'Helo',
    html: '<em>Helo</em>',
    silentReply: false,
  });

  await conversation.sendMessage(ROOM, 'typo');
  expect(sendMessage).toHaveBeenCalledWith(
    ROOM,
    'typo',
    expect.objectContaining({ inReplyTo: '$edit:example.org' })
  );
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

test('keeps an edited message kind and persona when returning to live drops its row', async () => {
  const original = {
    ...item('$original', '@kris:example.org'),
    content: {
      kind: 'message',
      body: 'before',
      html: 'before',
      emote: true,
      notice: false,
      edited: false,
    },
    per_message_profile: { display_name: 'Ghost', avatar_url: null },
  } as TimelineItemView;
  const fixture = setup([original], '@kris:example.org', {}, () => {
    fixture.timeline.items = [];
    return Promise.resolve();
  });
  fixture.conversation.edit('$original', 'before');
  await fixture.conversation.sendMessage(ROOM, 'after');
  expect(fixture.editMessage).toHaveBeenCalledWith(
    ROOM,
    '$original',
    'after',
    expect.objectContaining({ kind: 'emote', persona: original.per_message_profile })
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

test('an empty caption edit keeps the attachment', async () => {
  const { conversation, editMessage } = setup([], '@kris:example.org');
  conversation.edit('$image', 'caption', null, true);
  await conversation.sendMessage(ROOM, '');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    '$image',
    '',
    expect.objectContaining({ mediaCaption: true })
  );
});

function proxying() {
  setPreference('personaProxying', true);
  return setup([], '@kris:example.org', {
    personas: [
      {
        id: 'kris',
        display_name: 'Kris',
        avatar_url: null,
        pronouns: [],
        color_on_light: null,
        color_on_dark: null,
        triggers: [{ prefix: 'k:', suffix: null, keep_trigger: false }],
        pluralkit: null,
      },
    ],
  });
}

test.each([
  ['k:hello', 'k:<em>hello</em>'],
  ['k: hello ', 'k: <em>hello</em> '],
])('attachment captions apply persona triggers in %j', async (caption, formattedCaption) => {
  const { conversation, sendAttachment } = proxying();
  const file = new File(['picture'], 'picture.png', { type: 'image/png' });
  await conversation.sendAttachment(ROOM, file, { caption, formattedCaption });
  expect(sendAttachment.mock.lastCall).toMatchObject([
    ROOM,
    file,
    {
      caption: 'hello',
      formattedCaption: '<em>hello</em>',
      persona: { id: 'kris' },
    },
  ]);
});

test('messages trim whitespace after removing persona triggers', async () => {
  const { conversation, sendMessage } = proxying();
  await conversation.sendMessage(ROOM, 'k: hello ', 'k: <em>hello</em> ');
  expect(sendMessage.mock.lastCall).toMatchObject([
    ROOM,
    'hello',
    {
      formatted: '<em>hello</em>',
      persona: { id: 'kris' },
    },
  ]);
});

test('messages containing only a persona trigger and whitespace are not sent', async () => {
  const { conversation, sendMessage } = proxying();
  await conversation.sendMessage(ROOM, 'k: \t\n ');
  expect(sendMessage).not.toHaveBeenCalled();
});

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
  vi.restoreAllMocks();
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

test.each([
  ['m.room.name', 'Sent a m.room.name event', undefined],
  ['m.room.member', 'Sent a m.room.member event', undefined],
  [
    'm.room.message',
    'Message deleted',
    { redacted_because: { type: 'm.room.redaction', content: {} } },
  ],
  [
    'm.room.encrypted',
    'Message deleted',
    { redacted_because: { type: 'm.room.redaction', content: {} } },
  ],
])('uses event source for missing %s reply details', async (type, body, unsigned) => {
  const reply = {
    ...item('$reply:example.org', '@kris:example.org'),
    in_reply_to: { event_id: '$state:example.org', sender: null, body: null },
  } as unknown as TimelineItemView;
  const provideReplyFallback = vi.fn<(eventId: string, fallback: ReplyFallback) => void>();
  const eventSource = vi.fn(() =>
    Promise.resolve(JSON.stringify({ type, sender: '@ana:example.org', content: {}, unsigned }))
  );
  const core = {
    session: { user_id: '@kris:example.org' },
    commands: { fetchEventDetails: vi.fn(() => Promise.resolve()), eventSource },
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
    expect(provideReplyFallback).toHaveBeenCalledWith('$state:example.org', {
      sender: '@ana:example.org',
      body,
    });
  });
  expect(eventSource).toHaveBeenCalledWith(ROOM, '$state:example.org');
});

test('editing steps back to the own message before the one being edited', () => {
  const me = '@kris:example.org';
  const { conversation } = setup(
    [
      item('$one:example.org', me),
      item('$two:example.org', '@ana:example.org'),
      item('$three:example.org', me),
    ],
    me
  );

  conversation.editLast();
  expect(conversation.context).toMatchObject({ kind: 'edit', eventId: '$three:example.org' });

  conversation.editLast('$three:example.org');
  expect(conversation.context).toMatchObject({ kind: 'edit', eventId: '$one:example.org' });

  conversation.editLast('$one:example.org');
  expect(conversation.context).toMatchObject({ kind: 'edit', eventId: '$one:example.org' });
});

test('editing the last own message includes an image caption', () => {
  const me = '@kris:example.org';
  const image = {
    ...item('$image:example.org', me),
    content: {
      kind: 'image',
      filename: 'photo.png',
      caption: 'A photo',
      html: '<strong>A photo</strong>',
    },
  } as unknown as TimelineItemView;
  const { conversation } = setup([image], me);

  conversation.editLast();

  expect(conversation.context).toMatchObject({
    kind: 'edit',
    eventId: '$image:example.org',
    body: 'A photo',
    html: '<strong>A photo</strong>',
    mediaCaption: true,
  });
});

test('editing steps forward to the next own message and leaves after the last', () => {
  const me = '@kris:example.org';
  const { conversation } = setup(
    [
      item('$one:example.org', me),
      item('$two:example.org', '@ana:example.org'),
      item('$three:example.org', me),
    ],
    me
  );

  conversation.editLast('$three:example.org');
  conversation.editNext('$one:example.org');
  expect(conversation.context).toMatchObject({ kind: 'edit', eventId: '$three:example.org' });

  conversation.editNext('$three:example.org');
  expect(conversation.context).toBeNull();
});
