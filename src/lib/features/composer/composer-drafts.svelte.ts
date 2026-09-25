import { fingerprint } from '#lib/settings/fingerprint.js';

import type { StagedFile } from './composer-files';

export interface ComposerDraft {
  doc: unknown;
  staged: StagedFile[];
  nextStagedId: number;
}

const MAX_SYNCED_DRAFTS = 50;

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup must not subscribe the composer to every other room's draft
const drafts = new Map<string, ComposerDraft>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not a render source
const synced = new Map<string, string>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read through remoteRevision
const adopted = new Map<string, number>();
const revision = $state({ value: 0 });
const remote = $state({ value: 0 });

export function readDraft(roomId: string): ComposerDraft | undefined {
  return drafts.get(roomId);
}

export function writeDraft(roomId: string, draft: ComposerDraft): void {
  drafts.delete(roomId);
  drafts.set(roomId, draft);
  revision.value += 1;
}

export function clearDraft(roomId: string): void {
  if (!drafts.delete(roomId)) return;
  revision.value += 1;
}

export function clearDrafts(): void {
  drafts.clear();
  synced.clear();
  adopted.clear();
  revision.value += 1;
}

export function remoteRevision(roomId: string): number {
  void remote.value;
  return adopted.get(roomId) ?? 0;
}

export function draftDocuments(): Record<string, unknown> {
  void revision.value;

  const entries = [...drafts.entries()]
    .filter(([, draft]) => draft.doc !== null && draft.doc !== undefined)
    .slice(-MAX_SYNCED_DRAFTS);
  return Object.fromEntries(entries.map(([roomId, draft]) => [roomId, draft.doc]));
}

export function adoptDraftDocuments(documents: Record<string, unknown>): void {
  let changed = false;
  const dropped = [...synced.keys()].filter((roomId) => !(roomId in documents));
  for (const roomId of [...Object.keys(documents), ...dropped]) {
    const existing = drafts.get(roomId);
    const held = existing?.doc ?? null;
    const local = held === null ? null : fingerprint(held);
    const doc = documents[roomId] ?? null;
    const next = doc === null ? null : fingerprint(doc);
    const untouched = local === null || local === synced.get(roomId);

    if (next === null) synced.delete(roomId);
    else synced.set(roomId, next);
    if (!untouched || local === next) continue;

    if (doc === null && (existing?.staged.length ?? 0) === 0) drafts.delete(roomId);
    else
      drafts.set(roomId, {
        doc,
        staged: existing?.staged ?? [],
        nextStagedId: existing?.nextStagedId ?? 0,
      });
    adopted.set(roomId, (adopted.get(roomId) ?? 0) + 1);
    changed = true;
  }
  revision.value += 1;
  if (changed) remote.value += 1;
}
