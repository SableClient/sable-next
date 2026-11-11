import { afterEach, expect, test } from 'vitest';

import {
  adoptDraftDocuments,
  clearDraft,
  clearDrafts,
  draftDocuments,
  readBotCommand,
  readDraft,
  readReply,
  writeBotCommand,
  writeDraft,
  writeReply,
} from './composer-drafts.svelte';

const ROOM = '!room:example.org';
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', text }] });
const draft = (text: string) => ({ doc: doc(text), staged: [], nextStagedId: 0 });

afterEach(clearDrafts);

test('a room keeps its reply and bot command when its text draft is cleared', () => {
  const reply = { kind: 'reply', eventId: '$parent', body: 'hi', html: null } as const;
  const command = { command: {} as never, drafts: { days: '7' }, prefix: '/' };
  writeDraft(ROOM, draft('hello'));
  writeReply(ROOM, reply);
  writeBotCommand(ROOM, command);

  clearDraft(ROOM);

  expect(readDraft(ROOM)).toBeUndefined();
  expect(readReply(ROOM)).toEqual(reply);
  expect(readBotCommand(ROOM)).toEqual(command);
  writeReply(ROOM, null);
  writeBotCommand(ROOM, null);
  expect(draftDocuments()).toEqual({});
});

test('a late echo of an earlier upload does not bring a sent draft back', () => {
  writeDraft(ROOM, draft('hello wor'));
  draftDocuments();
  writeDraft(ROOM, draft('hello world'));
  draftDocuments();
  clearDraft(ROOM);

  adoptDraftDocuments({ [ROOM]: doc('hello wor') });

  expect(readDraft(ROOM)).toBeUndefined();
});

test('a different remote draft still replaces a cleared one', () => {
  writeDraft(ROOM, draft('hello'));
  draftDocuments();
  clearDraft(ROOM);

  adoptDraftDocuments({ [ROOM]: doc('from my phone') });

  expect(readDraft(ROOM)?.doc).toEqual(doc('from my phone'));
});
