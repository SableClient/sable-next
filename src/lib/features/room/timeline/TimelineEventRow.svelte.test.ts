// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { core, hover, resetTimelineItemTest, item } from './timeline-item-fixtures';
import { withRowFields } from './row-fixtures.js';

afterEach(resetTimelineItemTest);

test('renders a redacted row and a worded state change without throwing', async () => {
  for (const content of [
    { kind: 'redacted', reason: null, redacted_by: null } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      prev_content: null,
      change: { kind: 'room_topic', topic: 'what we do' },
    } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.power_levels',
      state_key: '',
      content: { users: {} },
      prev_content: null,
      change: null,
    } as const,
  ]) {
    const target = document.createElement('div');
    document.body.append(target);
    const component = render(TimelineItemHarness, {
      target,
      props: { core, item: { item: { ...item(false), content }, collapsed: false } },
    });
    await tick();

    expect(target.textContent.trim(), `${content.kind} rendered empty`).not.toBe('');
    component.unmount();
    target.remove();
  }
});

test('a membership row keeps its notice look and still carries the action layer', async () => {
  const joined: ResolvedItem = withRowFields({
    ...item(false),
    content: {
      kind: 'membership',
      user_id: '@alice:example.org',
      change: 'joined',
      display_name: 'Alice',
      reason: null,
    },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: joined, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const row = document.querySelector('article.event-row');
  if (!row) throw new Error('the membership event was not wrapped in an actionable row');
  expect(row.querySelector('.state')).not.toBeNull();
  expect(row.querySelector('header .sender')).toBeNull();

  await hover(row);
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();
});

test('a date divider stays a plain annotation with nothing to act on', async () => {
  const divider: ResolvedItem = withRowFields({
    ...item(false),
    event_id: null,
    content: { kind: 'date_divider', timestamp: 0 },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: divider, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  expect(document.querySelector('article')).toBeNull();
  expect(document.querySelector('.date-divider')).not.toBeNull();
});
