import { afterEach, expect, test } from 'vitest';

import {
  adoptDraftDocuments,
  clearDraft,
  clearDrafts,
  draftDocuments,
  readDraft,
  writeDraft,
} from './composer-drafts.svelte';

const ROOM = '!room:example.org';
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', text }] });
const draft = (text: string) => ({ doc: doc(text), staged: [], nextStagedId: 0 });

afterEach(clearDrafts);

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
