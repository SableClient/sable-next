import { describe, expect, test } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

import { TimelineIdentityTracker } from './timeline-identity';

function item(id: string, options: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id,
    event_id: `$${id}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body: id, html: id, emote: false, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    ...options,
    per_message_profile: options.per_message_profile ?? null,
  };
}

describe('TimelineIdentityTracker', () => {
  test('keeps a local echo key when its event id appears', () => {
    const tracker = new TimelineIdentityTracker();
    const local = item('local', { event_id: null, transaction_id: 'txn' });
    const remote = item('local', { transaction_id: null, event_id: '$remote' });
    expect(tracker.key([local], 0)).toBe('item:local');
    expect(tracker.key([remote], 0)).toBe('item:local');
  });

  test('prunes ids no longer present', () => {
    const tracker = new TimelineIdentityTracker();
    tracker.key([item('local', { event_id: null, transaction_id: 'txn' })], 0);
    expect(tracker.size()).toBe(1);
    tracker.reconcile([]);
    expect(tracker.size()).toBe(0);
  });

  test('gives boundaries a stable key based on the next event', () => {
    const tracker = new TimelineIdentityTracker();
    const divider = item('divider', {
      event_id: null,
      content: { kind: 'date_divider', timestamp: 0 },
    });
    expect(tracker.key([divider, item('message')], 0)).toBe('boundary:divider:event:$message');
  });
});
