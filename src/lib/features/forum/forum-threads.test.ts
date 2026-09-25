import { expect, test } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import { collectForumThreads } from './forum-threads';

function item(overrides: Partial<TimelineItemView> & { id: string }): TimelineItemView {
  return {
    event_id: `$${overrides.id}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: overrides.id,
      html: overrides.id,
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
    mention: 'none',
    forwarded: null,
    ...overrides,
  };
}

test('collects an item with a thread summary as a root', () => {
  const root = item({
    id: 'root',
    timestamp: 100,
    thread_summary: { num_replies: 2, latest_event_id: null, latest_body: 'latest' },
  });

  const threads = collectForumThreads([root], null);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.eventId).toBe('$root');
  expect(threads[0]?.replyCount).toBe(2);
  expect(threads[0]?.lastBody).toBe('latest');
  expect(threads[0]?.lastActivityAt).toBe(100);
});

test('collects a post nobody has replied to yet', () => {
  const plain = item({ id: 'plain', timestamp: 5 });

  const threads = collectForumThreads([plain], null);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.replyCount).toBe(0);
  expect(threads[0]?.lastBody).toBeNull();
});

test('ignores a thread reply, a plain reply and a state change', () => {
  const reply = item({ id: 'reply', thread_root: '$root' });
  const quoted = item({
    id: 'quoted',
    in_reply_to: {
      event_id: '$root',
      sender: null,
      sender_mentioned: false,
      sender_name: null,
      body: null,
    },
  });
  const joined = item({
    id: 'joined',
    content: {
      kind: 'membership',
      user_id: '@bob:example.org',
      change: 'joined',
      display_name: 'Bob',
      reason: null,
    },
  });

  expect(collectForumThreads([reply, quoted, joined], null)).toHaveLength(0);
});

test('takes last activity from the newest visible reply, not the root', () => {
  const root = item({
    id: 'root',
    timestamp: 100,
    thread_summary: { num_replies: 2, latest_event_id: null, latest_body: 'root summary' },
  });
  const reply = item({
    id: 'reply',
    timestamp: 300,
    thread_root: '$root',
    sender: '@bob:example.org',
    sender_name: 'Bob',
  });

  const threads = collectForumThreads([root, reply], null);

  expect(threads[0]?.lastActivityAt).toBe(300);
  expect(threads[0]?.lastSenderName).toBe('Bob');
});

test('sorts threads by most recent activity first', () => {
  const older = item({
    id: 'older',
    timestamp: 10,
    thread_summary: { num_replies: 0, latest_event_id: null, latest_body: null },
  });
  const newer = item({
    id: 'newer',
    timestamp: 20,
    thread_summary: { num_replies: 0, latest_event_id: null, latest_body: null },
  });

  const threads = collectForumThreads([older, newer], null);

  expect(threads.map((thread) => thread.eventId)).toEqual(['$newer', '$older']);
});

test('a thread is unread when the latest activity has no receipt from the current user', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@bob:example.org',
    thread_summary: { num_replies: 0, latest_event_id: null, latest_body: null },
    read_by: [],
  });

  expect(collectForumThreads([root], '@alice:example.org')[0]?.unread).toBe(true);
});

test('a thread is read once the current user has a receipt on the latest activity', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@bob:example.org',
    thread_summary: { num_replies: 0, latest_event_id: null, latest_body: null },
    read_by: ['@alice:example.org'],
  });

  expect(collectForumThreads([root], '@alice:example.org')[0]?.unread).toBe(false);
});

test('a thread you authored yourself is never unread', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@alice:example.org',
    thread_summary: { num_replies: 0, latest_event_id: null, latest_body: null },
    read_by: [],
  });

  expect(collectForumThreads([root], '@alice:example.org')[0]?.unread).toBe(false);
});

test('keeps the root details needed for its own forum actions', () => {
  const root = item({
    id: 'root',
    is_own: true,
    content: {
      kind: 'message',
      body: 'Original',
      html: '<strong>Original</strong>',
      emote: false,
      notice: false,
      edited: false,
    },
  });

  const thread = collectForumThreads([root], '@alice:example.org')[0];

  expect(thread).toMatchObject({
    eventId: '$root',
    isOwn: true,
    editable: true,
    html: '<strong>Original</strong>',
    mediaCaption: false,
  });
});
