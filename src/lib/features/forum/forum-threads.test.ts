import { expect, test } from 'vitest';

import type { PerMessageProfileView, TimelineItemView } from '#src/generated/protocol';

import { collectForumThreads, filterThreads, sortThreads } from './forum-threads';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

function item(overrides: Partial<TimelineItemView> & { id: string }): TimelineItemView {
  return withRowFields({
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
      msgtype: 'text',
      edited: false,
      jumbo: null,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    shared_by: null,
    redacted_on_ban: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
    shield: null,
    ...overrides,
  });
}

test('collects an item with a thread summary as a root', () => {
  const root = item({
    id: 'root',
    timestamp: 100,
    thread_summary: {
      num_replies: 2,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'latest',
      latest_fallback: null,
      latest_emotes: [],
    },
  });

  const threads = collectForumThreads([root], null);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.eventId).toBe('$root');
  expect(threads[0]?.replyCount).toBe(2);
  expect(threads[0]?.lastBody).toBe('latest');
  expect(threads[0]?.lastActivityAt).toBe(100);
});

test('hides a redacted post even when its thread summary remains', () => {
  const root = item({
    id: 'root',
    content: { kind: 'redacted', reason: null, redacted_by: null },
    thread_summary: {
      num_replies: 2,
      latest_event_id: '$reply',
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'latest',
      latest_fallback: null,
      latest_emotes: [],
    },
  });
  const reply = item({ id: 'reply', thread_root: '$root' });
  const visible = item({ id: 'visible' });

  expect(collectForumThreads([root, reply, visible], null).map((thread) => thread.eventId)).toEqual(
    ['$visible']
  );
});

test.each([false, true])(
  'a stale root cannot restore a redacted post (listed first: %s)',
  (listedFirst) => {
    const listed = item({ id: 'root' });
    const redacted = item({
      id: 'root',
      content: { kind: 'redacted', reason: null, redacted_by: null },
    });
    const items = listedFirst ? [listed, redacted] : [redacted, listed];

    expect(collectForumThreads(items, null)).toEqual([]);
  }
);

test('collects a post nobody has replied to yet', () => {
  const plain = item({ id: 'plain', timestamp: 5 });

  const threads = collectForumThreads([plain], null);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.replyCount).toBe(0);
  expect(threads[0]?.lastBody).toBeNull();
});

test('an own attachment post is edited through its caption', () => {
  const post = item({
    id: 'file',
    is_own: true,
    content: {
      kind: 'file',
      filename: 'main.rs',
      caption: 'the code',
      html: null,
      source: 'mxc://example.org/code',
      external_url: null,
      mime: 'text/plain',
      size: 128,
    },
  });

  const threads = collectForumThreads([post], null);

  expect(threads[0]?.editable).toBe(true);
  expect(threads[0]?.mediaCaption).toBe(true);
  expect(threads[0]?.preview).toBe('the code');
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
      fallback: null,
      emotes: [],
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
    thread_summary: {
      num_replies: 2,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'root summary',
      latest_fallback: null,
      latest_emotes: [],
    },
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
    thread_summary: {
      num_replies: 0,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: null,
      latest_fallback: null,
      latest_emotes: [],
    },
  });
  const newer = item({
    id: 'newer',
    timestamp: 20,
    thread_summary: {
      num_replies: 0,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: null,
      latest_fallback: null,
      latest_emotes: [],
    },
  });

  const threads = collectForumThreads([older, newer], null);

  expect(threads.map((thread) => thread.eventId)).toEqual(['$newer', '$older']);
});

test('a thread is unread when the latest activity has no receipt from the current user', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@bob:example.org',
    thread_summary: {
      num_replies: 0,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: null,
      latest_fallback: null,
      latest_emotes: [],
    },
    read_by: [],
    read_timestamps: {},
  });

  expect(collectForumThreads([root], '@alice:example.org')[0]?.unread).toBe(true);
});

test('a thread is read once the current user has a receipt on the latest activity', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@bob:example.org',
    thread_summary: {
      num_replies: 0,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: null,
      latest_fallback: null,
      latest_emotes: [],
    },
    read_by: ['@alice:example.org'],
  });

  expect(collectForumThreads([root], '@alice:example.org')[0]?.unread).toBe(false);
});

test('a thread you authored yourself is never unread', () => {
  const root = item({
    id: 'root',
    timestamp: 10,
    sender: '@alice:example.org',
    thread_summary: {
      num_replies: 0,
      latest_event_id: null,
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: null,
      latest_fallback: null,
      latest_emotes: [],
    },
    read_by: [],
    read_timestamps: {},
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
      msgtype: 'text',
      edited: false,
      jumbo: null,
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

test('carries the post title onto the thread', () => {
  const titled = item({ id: 'titled', forum_title: 'Rules' });
  const plain = item({ id: 'plain' });

  const threads = collectForumThreads([titled, plain], null);

  expect(threads.find((thread) => thread.eventId === '$titled')?.title).toBe('Rules');
  expect(threads.find((thread) => thread.eventId === '$plain')?.title).toBeNull();
});

test('uses hydrated latest replies and thread receipts when the main timeline hides replies', () => {
  const older = item({
    id: 'older',
    timestamp: 10,
    sender: '@alice:example.org',
    read_by: ['@alice:example.org'],
    thread_summary: {
      num_replies: 2,
      latest_event_id: '$reply',
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'New reply',
      latest_fallback: null,
      latest_emotes: [],
    },
  });
  const newer = item({ id: 'newer', timestamp: 20 });
  const reply = item({
    id: 'reply',
    timestamp: 30,
    thread_root: '$older',
    sender: '@bob:example.org',
    sender_name: 'Bob',
  });
  const threads = collectForumThreads([older, newer], '@alice:example.org', [reply]);
  expect(threads.map((thread) => thread.eventId)).toEqual(['$older', '$newer']);
  expect(threads[0]?.lastActivityAt).toBe(30);
  expect(threads[0]?.lastSenderName).toBe('Bob');
  expect(threads[0]?.unread).toBe(true);
  expect(
    collectForumThreads([older], '@alice:example.org', [reply], new Map([['$older', false]]))[0]
      ?.unread
  ).toBe(false);
});

test('counts each voter once across thumbs-up variants', () => {
  const root = item({
    id: 'root',
    reactions: [
      { key: '👍', senders: ['@a:example.org', '@b:example.org'] },
      { key: '👍🏽', senders: ['@a:example.org', '@c:example.org'] },
      { key: '🎉', senders: ['@d:example.org'] },
    ],
  });

  expect(collectForumThreads([root], null)[0]?.votes).toBe(3);
});

test('remembers which thumbs-up variant the user voted with', () => {
  const root = item({
    id: 'root',
    reactions: [
      { key: '👍', senders: ['@a:example.org'] },
      { key: '👍🏽', senders: ['@me:example.org'] },
      { key: '🎉', senders: ['@me:example.org'] },
    ],
  });

  expect(collectForumThreads([root], '@me:example.org')[0]?.ownVote).toBe('👍🏽');
  expect(collectForumThreads([root], '@other:example.org')[0]?.ownVote).toBeNull();
});

test('keeps the votes the timeline saw when the server lists the root too', () => {
  const seen = item({ id: 'root', reactions: [{ key: '👍', senders: ['@a:example.org'] }] });
  const listed = item({ id: 'root' });

  expect(collectForumThreads([seen, listed], null)[0]?.votes).toBe(1);
});

test('marks a thread resolved only when its author reacted with a check mark', () => {
  const byAuthor = item({
    id: 'done',
    reactions: [{ key: '✅', senders: ['@alice:example.org'] }],
  });
  const byOther = item({ id: 'open', reactions: [{ key: '✅', senders: ['@bob:example.org'] }] });

  const threads = collectForumThreads([byAuthor, byOther], null);

  expect(threads.find((thread) => thread.id === 'done')?.resolved).toBe(true);
  expect(threads.find((thread) => thread.id === 'open')?.resolved).toBe(false);
});

test('sorts by votes, then activity, with resolved threads last', () => {
  const voters = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `@voter${index}:example.org`);
  const threads = collectForumThreads(
    [
      item({ id: 'few', timestamp: 4, reactions: [{ key: '👍', senders: voters(1) }] }),
      item({ id: 'many', timestamp: 1, reactions: [{ key: '👍', senders: voters(3) }] }),
      item({ id: 'old', timestamp: 2 }),
      item({ id: 'new', timestamp: 3 }),
      item({
        id: 'done',
        timestamp: 5,
        reactions: [
          { key: '👍', senders: voters(9) },
          { key: '✅', senders: ['@alice:example.org'] },
        ],
      }),
    ],
    null
  );

  expect(sortThreads(threads, 'votes').map((thread) => thread.id)).toEqual([
    'many',
    'few',
    'new',
    'old',
    'done',
  ]);
});

test('sorts by the date a thread was started', () => {
  const reply = item({ id: 'reply', timestamp: 9, thread_root: '$first' });
  const threads = collectForumThreads(
    [item({ id: 'first', timestamp: 1 }), item({ id: 'second', timestamp: 2 }), reply],
    null
  );

  expect(threads.map((thread) => thread.id)).toEqual(['first', 'second']);
  expect(sortThreads(threads, 'created').map((thread) => thread.id)).toEqual(['second', 'first']);
});

test('filters threads by title, body or author', () => {
  const threads = collectForumThreads(
    [
      item({ id: 'titled', forum_title: 'Release Plans' }),
      item({ id: 'body' }),
      item({ id: 'other', sender_name: 'Bob' }),
    ],
    null
  );
  const ids = (query: string): string[] => filterThreads(threads, query).map((thread) => thread.id);

  expect(ids('  release ')).toEqual(['titled']);
  expect(ids('BODY')).toEqual(['body']);
  expect(ids('bob')).toEqual(['other']);
  expect(ids('')).toHaveLength(3);
});

test('takes the thumbnail from the first image or video of a thread', () => {
  const image = {
    kind: 'image' as const,
    filename: 'cat.png',
    caption: null,
    source: 'mxc://example.org/cat',
    mime: 'image/png',
    width: 640,
    height: 480,
    size: 1,
    blurhash: null,
    thumbnail: 'mxc://example.org/cat-small',
    spoiler: 'surprise',
  };
  const video = { ...image, kind: 'video' as const, thumbnail: null, spoiler: null };
  const threads = collectForumThreads(
    [
      item({ id: 'text' }),
      item({
        id: 'gallery',
        content: { kind: 'gallery', body: '', html: '', items: [image] },
      }),
      item({ id: 'bare', content: { kind: 'gallery', body: '', html: '', items: [video] } }),
    ],
    null
  );
  const thumbnail = (id: string) => threads.find((thread) => thread.id === id)?.thumbnail;

  expect(thumbnail('text')).toBeNull();
  expect(thumbnail('bare')).toBeNull();
  expect(thumbnail('gallery')).toMatchObject({
    source: 'mxc://example.org/cat',
    thumbnail: 'mxc://example.org/cat-small',
    video: false,
    spoiler: true,
  });
});

test('a deleted latest reply falls back to the previous reply', () => {
  const root = item({
    id: 'root',
    timestamp: 1,
    thread_summary: {
      num_replies: 2,
      latest_event_id: '$deleted',
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'Deleted reply text',
      latest_fallback: null,
      latest_emotes: [],
    },
  });
  const earlier = item({ id: 'earlier', thread_root: '$root', timestamp: 5 });
  const deleted = item({
    id: 'deleted',
    thread_root: '$root',
    timestamp: 9,
    content: { kind: 'redacted', reason: null, redacted_by: null },
  });

  const threads = collectForumThreads([root, earlier, deleted], null);
  expect(threads[0]?.lastBody).toBe('earlier');
  expect(threads[0]?.lastActivityAt).toBe(5);
});

test.each(['timeline', 'hydrated'])('a deleted latest reply from %s is not previewed', (source) => {
  const root = item({
    id: 'root',
    thread_summary: {
      num_replies: 1,
      latest_event_id: '$reply',
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'Deleted reply text',
      latest_fallback: null,
      latest_emotes: [],
    },
  });
  const reply = item({
    id: 'reply',
    thread_root: '$root',
    content: { kind: 'redacted', reason: null, redacted_by: null },
  });
  const threads =
    source === 'timeline'
      ? collectForumThreads([root, reply], null)
      : collectForumThreads([root], null, [reply]);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.preview).toBe('root');
  expect(threads[0]?.lastBody).toBeNull();
});

test('names the latest reply by its per-message profile', () => {
  const root = item({ id: 'root', timestamp: 100 });
  const reply = item({
    id: 'reply',
    timestamp: 300,
    thread_root: '$root',
    sender: '@bob:example.org',
    sender_name: 'Bob',
    per_message_profile: {
      id: 'p',
      display_name: 'Silver',
      avatar_url: null,
      pronouns: [],
    } as unknown as PerMessageProfileView,
  });

  expect(collectForumThreads([root, reply], null)[0]?.lastSenderName).toBe('Silver');
});
