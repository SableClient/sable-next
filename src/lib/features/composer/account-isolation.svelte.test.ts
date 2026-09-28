import { afterEach, expect, test, vi } from 'vitest';
import {
  clearDrafts,
  readDraft,
  writeDraft,
  draftDocuments,
  adoptDraftDocuments,
} from './composer-drafts.svelte';
import { adoptQueue, scheduledQueue, dueMessages } from './scheduled-queue.svelte';

const room = '!shared:test';
const draft = { doc: { text: 'private' }, staged: [], nextStagedId: 0 };
afterEach(() => {
  vi.useRealTimers();
  clearDrafts();
  adoptQueue([], 'a');
  adoptQueue([], 'b');
});

test('drafts and remote adoption are scoped to their account', () => {
  writeDraft(room, draft, 'a');
  expect(readDraft(room, 'b')).toBeUndefined();
  expect(draftDocuments('b')).toEqual({});
  adoptDraftDocuments({ [room]: { text: 'B' } }, 'b');
  expect(readDraft(room, 'a')).toEqual(draft);
  expect(readDraft(room, 'b')?.doc).toEqual({ text: 'B' });
});

test('a scheduled message cannot be taken over by another account', () => {
  const message = {
    id: 'one',
    roomId: room,
    body: 'private',
    formatted: null,
    dueTs: 0,
    owner: 'device-a',
  };
  adoptQueue([message], 'a');
  expect(scheduledQueue('b')).toEqual([]);
  expect(dueMessages(600_000, 'device-b', 'b')).toEqual([]);
  expect(dueMessages(600_000, 'device-a2', 'a')).toEqual([message]);
});

test('a pending draft upload is not reused for the next account', async () => {
  const { AccountSync } = await import('#lib/settings/account-sync.svelte.js');
  const { draftsDocumentFor } = await import('#lib/settings/sync-documents.js');
  vi.useFakeTimers();
  const session = { account_id: 'a' };
  const setSealedAccountData = vi.fn(() => Promise.resolve());
  const core = {
    session,
    commands: {
      sealedAccountData: () => Promise.resolve({ content: null, state: 'plain', can_seal: true }),
      setSealedAccountData,
    },
    subscribeEvents: () => () => {},
  } as unknown as import('#lib/core/client.svelte.js').CoreClient;
  const sync = new AccountSync();
  writeDraft(room, draft, 'a');
  const stop = sync.start(core, [draftsDocumentFor('a')]);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  session.account_id = 'b';
  writeDraft(room, { ...draft, doc: { text: 'B only' } }, 'b');
  const stopB = sync.start(core, [draftsDocumentFor('b')]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(setSealedAccountData).toHaveBeenCalledTimes(1);
  expect(setSealedAccountData).toHaveBeenCalledWith('moe.sable.next.drafts', {
    v: 1,
    drafts: { [room]: { text: 'B only' } },
  });
  stopB();
  vi.useRealTimers();
});
