import { expect, test } from 'vitest';

import { replyFallbackFromSource } from './reply-fallback';

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

test('a reply to a reaction names the reaction', () => {
  const source = JSON.stringify({
    type: 'm.reaction',
    sender: '@ana:example.org',
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$x', key: '👍' } },
  });

  expect(replyFallbackFromSource(source, t)).toEqual({
    sender: '@ana:example.org',
    body: 'timeline.replyToReaction:{"key":"👍"}',
  });
});

test('any other event falls back to its body, then its type', () => {
  expect(
    replyFallbackFromSource(
      JSON.stringify({ type: 'org.example.note', sender: '@b:x', content: { body: 'hi' } }),
      t
    )?.body
  ).toBe('hi');
  expect(
    replyFallbackFromSource(
      JSON.stringify({ type: 'm.room.topic', sender: '@b:x', content: {} }),
      t
    )?.body
  ).toBe('timeline.replyToEvent:{"type":"m.room.topic"}');
});

test('unreadable source gives nothing', () => {
  expect(replyFallbackFromSource('not json', t)).toBeNull();
  expect(replyFallbackFromSource('[]', t)).toBeNull();
});
