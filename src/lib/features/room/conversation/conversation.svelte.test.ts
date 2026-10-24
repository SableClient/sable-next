// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { clearDrafts } from '#lib/composer/composer-drafts.svelte.js';
import { adoptQueue, scheduledQueue } from '#lib/composer/scheduled-queue.svelte.js';
import { ScheduledOriginalKept } from '#lib/features/composer/send-failure.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { composerSchema } from '#lib/features/composer/editor/schema.js';
import { SlashError } from '#lib/features/composer/slash-commands.js';
import * as runtime from '#lib/config/runtime-config.js';

import * as messagesApi from '#lib/core/api/messages.svelte.js';

import { Conversation } from './conversation.svelte';

vi.mock('#lib/core/api/messages.svelte.js', () => ({ sendMessage: vi.fn(), editMessage: vi.fn() }));
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

const ROOM = '!room:example.org';

function item(eventId: string, sender: string): ResolvedItem {
  return withRowFields({
    id: eventId,
    event_id: eventId,
    sender,
    sender_name: 'Ana',
    reactions: [],
    content: { kind: 'message', body: 'Hello', html: '<p>Hello</p>' },
  } as unknown as ResolvedItem);
}

function setup(
  items: ResolvedItem[],
  userId: string,
  store: Partial<PersonaStore> = {},
  beforeSend?: () => Promise<void>,
  threadRoot: string | null = null
) {
  const sendMessage = vi.fn((..._args: unknown[]) => Promise.resolve());
  const editMessage = vi.fn((..._args: unknown[]) => Promise.resolve());
  vi.mocked(messagesApi.sendMessage).mockImplementation((_rpc, ...args) => sendMessage(...args));
  vi.mocked(messagesApi.editMessage).mockImplementation((_rpc, ...args) => editMessage(...args));
  const sendAttachment = vi.fn(() => Promise.resolve());
  const sendGallery = vi.fn(() => Promise.resolve());
  const sendGif = vi.fn(() => Promise.resolve());
  const sendLocation = vi.fn(() => Promise.resolve());
  const createPoll = vi.fn(() => Promise.resolve());
  const votePoll = vi.fn(() => Promise.resolve());
  const endPoll = vi.fn(() => Promise.resolve());
  const sendSticker = vi.fn(() => Promise.resolve());
  const schedule = vi.fn(() => Promise.resolve('delay'));
  const sendGesture = vi.fn(() => Promise.resolve());
  const toggleReaction = vi.fn(() => Promise.resolve());
  const urlPreview = vi.fn(() => Promise.resolve(null));
  const core = {
    session: { user_id: userId },
    media: {
      sendAttachment,
      sendGallery,
    },
    rpc: {
      messages: {
        sendGif,
        sendLocation,
        createPoll,
        votePoll,
        endPoll,
        sendSticker,
        schedule,
        sendGesture,
        react: toggleReaction,
        urlPreview,
      },
      account: {},
    },
  } as unknown as CoreClient;
  const stub = {
    personas: [],
    selectionFor: () => null,
    disabledIn: () => false,
    select: () => Promise.resolve(),
    save: () => Promise.resolve(),
    ...store,
  };
  const personas = {
    ...stub,
    associationFor: (id: string) =>
      stub.disabledIn(id) ? false : (stub.selectionFor(id) ?? undefined),
  } as unknown as PersonaStore;
  const timeline = {
    items,
    aggregations: [] as ResolvedItem[],
    subscriptionId: 7,
  };

  return {
    sendMessage,
    editMessage,
    sendAttachment,
    sendGallery,
    sendGif,
    sendLocation,
    createPoll,
    votePoll,
    endPoll,
    sendSticker,
    schedule,
    sendGesture,
    toggleReaction,
    urlPreview,
    timeline,
    conversation: new Conversation({
      core,
      personas,
      timeline: timeline as unknown as RoomTimeline,
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
    withRowFields({
      ...item('$state', '@ana:example.org'),
      content: { kind: 'state_event' },
    } as ResolvedItem),
    { ...item('$pending', '@kris:example.org'), event_id: null },
    withRowFields({
      ...item('$redacted', '@ana:example.org'),
      content: { kind: 'redacted', reason: null, redacted_by: null },
    }),
  ];
  live.resolve(undefined);
  await reacting;
  expect(fixture.toggleReaction).toHaveBeenCalledWith({
    room_id: ROOM,
    event_id: '$latest',
    key: '😂',
    source_pack: null,
    shortcode: null,
    thread_root: null,
    subscription: 7,
    persona: null,
  });
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
    const latest = withRowFields({
      ...item('$latest', '@ana:example.org'),
      content: { kind },
    } as ResolvedItem);
    const fixture = setup([item('$old', '@ana:example.org'), latest], '@kris:example.org');
    await fixture.conversation.quickReact(ROOM, '😂');
    expect(fixture.toggleReaction).toHaveBeenCalledWith({
      room_id: ROOM,
      event_id: '$latest',
      key: '😂',
      source_pack: null,
      shortcode: null,
      thread_root: null,
      subscription: 7,
      persona: null,
    });
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
  expect(fixture.toggleReaction).toHaveBeenCalledWith({
    room_id: ROOM,
    event_id: '$reply',
    key: 'mxc://example.org/wave',
    source_pack: sourcePack,
    shortcode: null,
    thread_root: '$root',
    subscription: 7,
    persona: null,
  });
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
  expect(fixture.toggleReaction).toHaveBeenCalledWith({
    room_id: ROOM,
    event_id: '$latest',
    key: key,
    source_pack: null,
    shortcode: null,
    thread_root: null,
    subscription: 7,
    persona: null,
  });
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
    expect.objectContaining({ in_reply_to: '$one:example.org', silent_reply: false })
  );
});

test('a reply survives leaving the room and coming back', () => {
  const items = [item('$one:example.org', '@ana:example.org')];
  const first = setup(items, '@kris:example.org');
  first.conversation.reply('$one:example.org');

  const returned = setup(items, '@kris:example.org');
  expect(returned.conversation.context?.eventId).toBe('$one:example.org');

  returned.conversation.clearContext();
  expect(setup(items, '@kris:example.org').conversation.context).toBeNull();
});

test('a thread keeps its own pending reply', () => {
  const items = [item('$one:example.org', '@ana:example.org')];
  setup(items, '@kris:example.org').conversation.reply('$one:example.org');

  expect(setup(items, '@kris:example.org', {}, undefined, '$root').conversation.context).toBeNull();
});

test('a sent reply is not restored', async () => {
  const items = [item('$one:example.org', '@ana:example.org')];
  const { conversation } = setup(items, '@kris:example.org');
  conversation.reply('$one:example.org');
  await conversation.sendMessage(ROOM, 'sure');

  expect(setup(items, '@kris:example.org').conversation.context).toBeNull();
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
    expect.objectContaining({ silent_reply: true })
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
    const mentions = { user_ids: ['@bea:example.org'], room: false };

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
          {
            room_id: ROOM,
            url: expect.any(String) as string,
            body: 'cat.gif',
            width: 320,
            height: 240,
            mimetype: 'image/gif',
            size: 1000,
            in_reply_to: '$one:example.org',
            silent_reply: silentReply,
            thread_root: threadRoot,
            persona: null,
          },
        ]);
      } else {
        await conversation.sendLocation(ROOM, 'here', 'geo:48,2');
        expect(fixture.sendLocation).toHaveBeenLastCalledWith({
          room_id: ROOM,
          body: 'here',
          geo_uri: 'geo:48,2',
          persona: null,
          in_reply_to: '$one:example.org',
          silent_reply: silentReply,
          thread_root: threadRoot,
        });
      }
      expect(conversation.context).toBeNull();
    }
  }
);

test('a reply to a persona message names the persona', () => {
  const target = withRowFields({
    ...item('$one:example.org', '@ana:example.org'),
    per_message_profile: { display_name: 'Ghost' },
  } as unknown as ResolvedItem);
  const { conversation } = setup([target], '@kris:example.org');

  conversation.reply('$one:example.org');
  expect(conversation.context?.sender).toBe('Ghost');
});

test('a visible reaction aggregation can be replied to', () => {
  const reaction = withRowFields({
    ...item('$reaction:example.org', '@ana:example.org'),
    content: {
      kind: 'hidden_event',
      event_type: 'm.reaction',
      content: { 'm.relates_to': { event_id: '$message:example.org', key: '🎉' } },
      redacts: null,
    },
  });
  const { conversation, timeline } = setup([], '@kris:example.org');
  timeline.aggregations = [reaction];

  conversation.reply('$reaction:example.org');

  expect(conversation.context).toMatchObject({
    kind: 'reply',
    eventId: '$reaction:example.org',
    sender: 'Ana',
    body: 'Ana reacted with 🎉',
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
    expect.objectContaining({ in_reply_to: '$edit:example.org' })
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
    expect.objectContaining({ transaction_id: 'transaction-1' })
  );
});

test('editing a file caption replaces the caption and keeps the attachment', async () => {
  const file = withRowFields({
    ...item('$file', '@kris:example.org'),
    content: {
      kind: 'file',
      filename: 'main.rs',
      caption: 'the code',
      html: null,
      source: 'mxc://example.org/code',
      mime: 'text/plain',
      size: 128,
    },
  } as unknown as ResolvedItem);
  const { conversation, editMessage } = setup([file], '@kris:example.org');

  conversation.editLast();
  expect(conversation.context).toMatchObject({
    kind: 'edit',
    eventId: '$file',
    body: 'the code',
    mediaCaption: true,
  });

  await conversation.sendMessage(ROOM, 'the new code');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    '$file',
    'the new code',
    expect.objectContaining({ media_caption: true })
  );
});

function ownMessage(eventId: string, body: string): ResolvedItem {
  return withRowFields({
    ...item(eventId, '@kris:example.org'),
    content: { kind: 'message', body, html: `<p>${body}</p>` },
  } as unknown as ResolvedItem);
}

test('s/old/new edits your last message when sed edits are on', async () => {
  setPreference('sedEdits', true);
  const { conversation, editMessage, sendMessage } = setup(
    [
      ownMessage('$first', 'one fish'),
      item('$theirs', '@ana:example.org'),
      ownMessage('$last', 'two fish'),
    ],
    '@kris:example.org'
  );

  await conversation.sendMessage(ROOM, 's/fish/cat');

  expect(editMessage).toHaveBeenCalledWith(ROOM, '$last', 'two cat', expect.any(Object));
  expect(sendMessage).not.toHaveBeenCalled();
  setPreference('sedEdits', false);
});

test('s/old/new is sent as written when sed edits are off', async () => {
  const { conversation, editMessage, sendMessage } = setup(
    [ownMessage('$last', 'two fish')],
    '@kris:example.org'
  );

  await conversation.sendMessage(ROOM, 's/fish/cat');

  expect(editMessage).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(ROOM, 's/fish/cat', expect.any(Object));
});

test('s/old/new reports a last message that does not contain the text', async () => {
  setPreference('sedEdits', true);
  const { conversation, editMessage, sendMessage } = setup(
    [ownMessage('$last', 'two fish')],
    '@kris:example.org'
  );

  await expect(conversation.sendMessage(ROOM, 's/dog/cat')).rejects.toBeInstanceOf(SlashError);

  expect(editMessage).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  setPreference('sedEdits', false);
});

test('an edit shows in the timeline only when inline editing is on and the target is text', () => {
  const caption = withRowFields({
    ...item('$photo', '@kris:example.org'),
    content: { kind: 'image', caption: 'sunset', html: 'sunset' },
  } as unknown as ResolvedItem);
  const { conversation } = setup([ownMessage('$text', 'hello'), caption], '@kris:example.org');

  conversation.edit('$text', 'hello', null);
  expect(conversation.inlineEdit).toBe(false);

  setPreference('inlineEditing', true);
  expect(conversation.inlineEdit).toBe(true);

  conversation.edit('$photo', 'sunset', null, true);
  expect(conversation.inlineEdit).toBe(false);

  conversation.clearContext();
  expect(conversation.inlineEdit).toBe(false);
  setPreference('inlineEditing', false);
});

test('an inline draft comes back once, for the message it was typed in', () => {
  const { conversation } = setup([ownMessage('$text', 'hello')], '@kris:example.org');
  const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph')]);

  conversation.stashInlineDraft('$text', doc);

  expect(conversation.takeInlineDraft('$other')).toBeUndefined();
  conversation.stashInlineDraft('$text', doc);
  expect(conversation.takeInlineDraft('$text')).toBe(doc);
  expect(conversation.takeInlineDraft('$text')).toBeUndefined();
});

test('keeps an edited message kind and persona when returning to live drops its row', async () => {
  const original = withRowFields({
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
  } as ResolvedItem);
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
  const items: ResolvedItem[] = [pending];
  const { conversation, editMessage } = setup(items, '@kris:example.org');
  conversation.editLast();
  items[0] = { ...pending, event_id: '$sent', transaction_id: null };
  await conversation.sendMessage(ROOM, 'corrected');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    '$sent',
    'corrected',
    expect.objectContaining({ transaction_id: null })
  );
});

function encryptedScheduleFailure(): Error {
  const error = new Error('encrypted');
  Object.assign(error, { detail: { code: 'encrypted_schedule_unsupported' } });
  return error;
}

test('an edit that changes nothing sends no event', async () => {
  const { conversation, editMessage } = setup(
    [item('$original', '@kris:example.org')],
    '@kris:example.org'
  );
  conversation.edit('$original', 'same');
  await conversation.sendMessage(ROOM, 'same');
  expect(editMessage).not.toHaveBeenCalled();
  expect(conversation.context).toBeNull();
});

test('an empty caption edit keeps the attachment', async () => {
  const { conversation, editMessage } = setup([], '@kris:example.org');
  conversation.edit('$image', 'caption', null, true);
  await conversation.sendMessage(ROOM, '');
  expect(editMessage).toHaveBeenCalledWith(
    ROOM,
    '$image',
    '',
    expect.objectContaining({ media_caption: true })
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
        triggers: [{ prefix: 'k:', suffix: null, keep_trigger: false, alternate_avatar_id: null }],
        pluralkit: null,
        last_used: null,
        alternate_avatars: null,
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
    triggers: [{ prefix: 'k:', suffix: null, keep_trigger: false, alternate_avatar_id: null }],
    pluralkit: null,
    last_used: null,
    alternate_avatars: null,
  };
  const select = vi.fn(() => Promise.resolve());
  const { conversation, sendMessage } = setup([], '@kris:example.org', {
    personas: [kris],
    selectionFor: (roomId) =>
      roomId === null ? { persona_id: 'kris', valid_until: null, alternate_avatar_id: null } : null,
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
    rpc: { messages: { schedule: scheduleMessage } },
  } as unknown as CoreClient;

  return new Conversation({
    core,
    personas: {
      personas: [],
      selectionFor: () => null,
      associationFor: () => undefined,
    } as unknown as PersonaStore,
    timeline: { items: [] } as unknown as RoomTimeline,
    roomId: () => ROOM,
    encrypted: () => true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  adoptQueue([]);
  clearDrafts();
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
  const cancel = vi.fn((_params: { delay_id: string }) => {
    calls.push('cancel');
    return cancelScheduledMessage();
  });
  const core = {
    session: { user_id: '@kris:example.org', device_id: 'DEV' },
    rpc: { messages: { schedule: schedule, cancelScheduled: cancel } },
  } as unknown as CoreClient;
  const conversation = new Conversation({
    core,
    personas: {
      personas: [],
      selectionFor: () => null,
      associationFor: () => undefined,
    } as unknown as PersonaStore,
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
  expect(cancel).toHaveBeenCalledWith({ delay_id: 'old' });
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
  const image = withRowFields({
    ...item('$image:example.org', me),
    content: {
      kind: 'image',
      filename: 'photo.png',
      caption: 'A photo',
      html: '<strong>A photo</strong>',
    },
  } as unknown as ResolvedItem);
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

const LINKS = '<p><a href="https://a.example/">a</a> <a href="https://b.example/">b</a></p>';

test('a dismissed link is not previewed and the dismissal is spent by the send', async () => {
  setPreference('encryptedUrlPreviews', true);
  const fixture = setup([], '@kris:example.org');
  fixture.conversation.dismissPreview('https://a.example/');
  await fixture.conversation.sendMessage(ROOM, 'a b', LINKS);

  expect(fixture.urlPreview).toHaveBeenCalledTimes(1);
  expect(fixture.urlPreview).toHaveBeenCalledWith({ url: 'https://b.example/', service: null });
  expect(fixture.sendMessage.mock.calls[0]?.[2]).toMatchObject({
    no_link_previews: false,
  });
  expect(fixture.conversation.dismissedPreviews).toEqual([]);
});

test('dismissing every link sends an explicit opt-out', async () => {
  setPreference('encryptedUrlPreviews', true);
  const fixture = setup([], '@kris:example.org');
  fixture.conversation.dismissPreview('https://a.example/');
  fixture.conversation.dismissPreview('https://b.example/');
  await fixture.conversation.sendMessage(ROOM, 'a b', LINKS);

  expect(fixture.urlPreview).not.toHaveBeenCalled();
  expect(fixture.sendMessage.mock.calls[0]?.[2]).toMatchObject({
    link_previews: [],
    no_link_previews: true,
  });
});

test.each([false, true])(
  'message types respect the selected PMP with room disabled=%s',
  async (disabled) => {
    const persona = {
      id: 'kris',
      display_name: 'Kris',
      avatar_url: null,
      pronouns: [],
      color_on_light: null,
      color_on_dark: null,
      triggers: [],
      pluralkit: null,
      last_used: null,
      alternate_avatars: null,
    };
    const h = setup([], '@kris:example.org', {
      personas: [persona],
      selectionFor: () => ({ persona_id: 'kris', valid_until: null, alternate_avatar_id: null }),
      disabledIn: () => disabled,
    });
    const profile: unknown = disabled
      ? null
      : expect.objectContaining({ id: 'kris', display_name: 'Kris' });
    await h.conversation.createPoll(ROOM, 'Lunch?', ['Soup', 'Pasta'], false);
    expect(h.createPoll).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    h.conversation.votePoll('$poll', ['0']);
    expect(h.votePoll).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    h.conversation.endPoll('$poll');
    expect(h.endPoll).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    await h.conversation.sendLocation(ROOM, 'here', 'geo:48,2');
    expect(h.sendLocation).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    await h.conversation.sendSticker(ROOM, 'mxc://example.org/sticker', 'wave');
    expect(h.sendSticker).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    const image = new File(['image'], 'one.png', { type: 'image/png' });
    await h.conversation.sendGallery(ROOM, [image, image]);
    expect(h.sendGallery).toHaveBeenCalledWith(
      ROOM,
      [image, image],
      expect.objectContaining({ persona: profile })
    );
    await h.conversation.sendBotCommand(ROOM, '@bot:example.org', '!help', {
      command: 'help',
      arguments: {},
    });
    expect(h.sendMessage).toHaveBeenCalledWith(
      ROOM,
      '!help',
      expect.objectContaining({ persona: profile })
    );
    await h.conversation.sendMessage(ROOM, '/hug');
    expect(h.sendGesture).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
    await h.conversation.schedule(ROOM, 'later', null, Date.now() + 60_000);
    expect(h.schedule).toHaveBeenCalledWith(expect.objectContaining({ persona: profile }));
  }
);
