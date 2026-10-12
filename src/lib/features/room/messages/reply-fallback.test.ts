import { expect, test } from 'vitest';

import type { ReplyView } from '#src/generated/protocol';

import { replyText } from './reply-fallback';

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

function reply(body: string | null, fallback: ReplyView['fallback']): ReplyView {
  return {
    event_id: '$x',
    sender: null,
    sender_mentioned: false,
    sender_name: null,
    body,
    fallback,
  };
}

test('a reply quotes its body, or says what the replied-to event was', () => {
  expect(replyText(reply('hi', null), t)).toBe('hi');
  expect(replyText(reply(null, { kind: 'reaction', key: '👍' }), t)).toBe(
    'timeline.replyToReaction:{"key":"👍"}'
  );
  expect(replyText(reply(null, { kind: 'event', event_type: 'm.room.topic' }), t)).toBe(
    'timeline.replyToEvent:{"type":"m.room.topic"}'
  );
  expect(replyText(reply(null, { kind: 'redacted' }), t)).toBe('timeline.redacted');
  expect(replyText(reply(null, { kind: 'redaction' }), t)).toBe('timeline.replyToRedaction');
  expect(replyText(reply(null, null), t)).toBe('');
  expect(replyText(null, t)).toBe('');
});
