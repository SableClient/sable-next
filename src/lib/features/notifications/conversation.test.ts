import { expect, test } from 'vitest';

import {
  appendLine,
  type ConversationLine,
  MAX_CONVERSATION_LINES,
  readLines,
  summarise,
} from './conversation';

test('a conversation keeps the newest lines and drops the rest', () => {
  let lines: ConversationLine[] = [{ sender: 'Ada', body: 'one', eventId: '$one' }];
  for (const body of ['two', 'three', 'four', 'five', 'six']) {
    lines = appendLine(lines, { sender: 'Ada', body, eventId: `$${body}` });
  }

  expect(lines).toHaveLength(MAX_CONVERSATION_LINES);
  expect(lines.at(0)?.body).toBe('two');
  expect(lines.at(-1)?.body).toBe('six');
});

test('an event already on the alert is not appended a second time', () => {
  const lines = appendLine([{ sender: 'Ada', body: 'one', eventId: '$one' }], {
    sender: 'Ada',
    body: 'one',
    eventId: '$one',
  });

  expect(lines).toEqual([{ sender: 'Ada', body: 'one', eventId: '$one' }]);
});

test('a line with no event id is always appended', () => {
  const lines = appendLine([{ sender: 'Ada', body: 'one', eventId: null }], {
    sender: 'Ada',
    body: 'one',
    eventId: null,
  });

  expect(lines).toHaveLength(2);
});

test('a chat line carries no sender, a room line does', () => {
  expect(summarise([{ sender: null, body: 'hello', eventId: null }])).toBe('hello');
  expect(
    summarise([
      { sender: 'Ada', body: 'hello', eventId: null },
      { sender: 'Bo', body: 'hi', eventId: null },
    ])
  ).toBe('Ada: hello\nBo: hi');
});

test('lines read back off a notification drop whatever is not a line', () => {
  expect(
    readLines([
      { sender: 'Ada', body: 'hello', eventId: '$hello' },
      { body: 'anon' },
      { sender: 'Bo' },
      7,
    ])
  ).toEqual([
    { sender: 'Ada', body: 'hello', eventId: '$hello' },
    { sender: null, body: 'anon', eventId: null },
  ]);
  expect(readLines(undefined)).toEqual([]);
});
