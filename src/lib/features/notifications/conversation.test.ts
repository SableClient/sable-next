import { expect, test } from 'vitest';

import {
  appendLine,
  type ConversationLine,
  MAX_CONVERSATION_LINES,
  readLines,
  summarise,
} from './conversation';

test('a conversation keeps the newest lines and drops the rest', () => {
  let lines: ConversationLine[] = [{ sender: 'Ada', body: 'one' }];
  for (const body of ['two', 'three', 'four', 'five', 'six']) {
    lines = appendLine(lines, { sender: 'Ada', body });
  }

  expect(lines).toHaveLength(MAX_CONVERSATION_LINES);
  expect(lines.at(0)?.body).toBe('two');
  expect(lines.at(-1)?.body).toBe('six');
});

test('a chat line carries no sender, a room line does', () => {
  expect(summarise([{ sender: null, body: 'hello' }])).toBe('hello');
  expect(
    summarise([
      { sender: 'Ada', body: 'hello' },
      { sender: 'Bo', body: 'hi' },
    ])
  ).toBe('Ada: hello\nBo: hi');
});

test('lines read back off a notification drop whatever is not a line', () => {
  expect(
    readLines([{ sender: 'Ada', body: 'hello' }, { body: 'anon' }, { sender: 'Bo' }, 7])
  ).toEqual([
    { sender: 'Ada', body: 'hello' },
    { sender: null, body: 'anon' },
  ]);
  expect(readLines(undefined)).toEqual([]);
});
