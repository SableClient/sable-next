import { expect, test } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import {
  editedBody,
  isEditEvent,
  redactionTarget,
  relationOf,
  TimelineEventIndex,
} from './timeline-event-index';

function hidden(
  eventId: string,
  eventType: string,
  content: unknown,
  timestamp = 0,
  redacts: string | null = null
): TimelineItemView {
  return {
    id: eventId,
    event_id: eventId,
    timestamp,
    content: { kind: 'hidden_event', event_type: eventType, content, redacts },
  } as TimelineItemView;
}

function edit(eventId: string, target: string, body: string, timestamp: number): TimelineItemView {
  return hidden(
    eventId,
    'm.room.message',
    {
      body: `* ${body}`,
      'm.new_content': { body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    },
    timestamp
  );
}

test('reads the relation, the replacement body and the redacted event', () => {
  const first = edit('$e1', '$m', 'one', 1);
  expect(relationOf(first.content.kind === 'hidden_event' ? first.content.content : null)).toEqual({
    eventId: '$m',
    relType: 'm.replace',
  });
  expect(isEditEvent(first)).toBe(true);
  expect(isEditEvent(hidden('$r', 'm.reaction', {}))).toBe(false);
  expect(editedBody({ 'm.new_content': { body: 'one' } })).toBe('one');
  expect(redactionTarget(hidden('$x', 'm.room.redaction', {}, 0, '$old'))).toBe('$old');
  expect(redactionTarget(hidden('$x', 'm.room.redaction', { redacts: '$v11' }))).toBe('$v11');
});

test('an edit diffs against the edit before it', () => {
  const message = { id: '$m', event_id: '$m', content: { kind: 'message' } } as TimelineItemView;
  const first = edit('$e1', '$m', 'one', 1);
  const second = edit('$e2', '$m', 'two', 2);
  const other = edit('$e3', '$n', 'three', 1);
  const index = new TimelineEventIndex([message], [second, other, first]);

  expect(index.get('$m')).toBe(message);
  expect(index.get('$e2')).toBe(second);
  expect(index.editBefore(second)).toBe(first);
  expect(index.editBefore(first)).toBeNull();
});
