// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { InboxItemView, TimelineItemView } from '#src/generated/protocol';

const loaded = new Map<string, Partial<TimelineItemView>>();
vi.mock('#lib/features/room/messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: (_roomId: string, eventId: string) => loaded.get(eventId) }),
}));

import NotificationReason from './NotificationReason.svelte';

function item(overrides: Partial<InboxItemView>): InboxItemView {
  return {
    room_id: '!room',
    event_id: '$e',
    ts: 1,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    body: 'hi',
    highlight: false,
    is_direct: false,
    encrypted: false,
    read: false,
    thread_root: null,
    reply: false,
    ...overrides,
  };
}

test.each([
  [{ reply: true, highlight: true }, 'Replied to you'],
  [{ reply: true }, 'Reply'],
  [{ highlight: true }, 'Mentions you'],
  [{ thread_root: '$root', highlight: true }, 'Mentions you In a thread'],
])('says why %o notified', (overrides, text) => {
  const { container } = render(NotificationReason, { item: item(overrides) });
  expect(container.textContent.replace(/\s+/g, ' ').trim()).toBe(text);
});

test('a plain notification gets no reason line', () => {
  render(NotificationReason, { item: item({}) });
  expect(screen.queryByRole('paragraph')).toBeNull();
});

test('a reply recorded before replies were tracked is read from the loaded message', () => {
  loaded.set('$old', { in_reply_to: { event_id: '$p' } as TimelineItemView['in_reply_to'] });
  const { container } = render(NotificationReason, {
    item: item({ event_id: '$old', highlight: true }),
  });
  expect(container.textContent.trim()).toBe('Replied to you');
});
