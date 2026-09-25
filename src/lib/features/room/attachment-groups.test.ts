import { expect, test } from 'vitest';

import type { RoomAttachmentView } from '#src/generated/protocol';

import { groupByMonth } from './attachment-groups';

function at(eventId: string, timestamp: number): RoomAttachmentView {
  return {
    event_id: eventId,
    gallery_index: null,
    sender: '@ana:example.org',
    timestamp,
    content: { kind: 'link', urls: ['https://example.org'], body: 'https://example.org' },
  };
}

test('keeps newest-first order and starts a group at each new month', () => {
  const groups = groupByMonth([
    at('$c', new Date(2024, 2, 20).getTime()),
    at('$b', new Date(2024, 2, 2).getTime()),
    at('$a', new Date(2024, 1, 28).getTime()),
  ]);

  expect(groups.map((group) => group.items.map((item) => item.event_id))).toEqual([
    ['$c', '$b'],
    ['$a'],
  ]);
  expect(groups[0]?.label).toContain('2024');
});

test('the same month in two years is two groups', () => {
  const groups = groupByMonth([
    at('$new', new Date(2024, 4, 1).getTime()),
    at('$old', new Date(2023, 4, 1).getTime()),
  ]);

  expect(groups).toHaveLength(2);
});
