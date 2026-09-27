import { expect, test } from 'vitest';
import type { TimelineItemView } from '#src/generated/protocol';

import { messageActionPolicy } from './message-action-policy';

function item(overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: 'hello',
      html: '<b>hello</b>',
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: true,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
    forwarded: null,
    ...overrides,
  };
}

function policy(overrides: Partial<TimelineItemView> = {}) {
  return messageActionPolicy({
    item: item(overrides),
    roomId: '!room:example.org',
    canPin: true,
    canRedactOwn: true,
    canRedactOthers: false,
    canToggleReaction: true,
    canMarkUnread: true,
    canReply: true,
    canEdit: true,
    canDelete: true,
    canOpenThread: true,
    canCopyLink: true,
    pinned: false,
    bookmarked: false,
    stealCount: 0,
  });
}

test('local sends expose only actions that do not require a server event', () => {
  const actions = policy({ event_id: null, transaction_id: 'local' });

  expect(actions.edit).toBe(true);
  expect(actions.editId).toBe('local');
  expect(actions.pin).toBe(false);
  expect(actions.bookmark).toBe(false);
  expect(actions.viewSource).toBe(false);
  expect(actions.reproxy).toBe(false);
});

test('policy centralizes ownership and permission gates', () => {
  const other = policy({ is_own: false });

  expect(other.edit).toBe(false);
  expect(other.redact).toBe(false);
  expect(other.report).toBe(true);
});

test('media and threaded events expose their respective actions', () => {
  const media = policy({
    content: {
      kind: 'image',
      html: null,
      filename: 'photo.png',
      caption: null,
      source: 'mxc://example.org/photo',
      mime: 'image/png',
      width: null,
      height: null,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
    },
    thread_root: '$root',
  });

  expect(media.download).toBe(true);
  expect(media.openThread).toBe(true);
  expect(media.threadTarget).toBe('$root');
  expect(media.copyText).toBe(true);
});
