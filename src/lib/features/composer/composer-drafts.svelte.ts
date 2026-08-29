import type { StagedFile } from './composer-files';

export interface ComposerDraft {
  doc: unknown;
  staged: StagedFile[];
  nextStagedId: number;
}

const MAX_SYNCED_DRAFTS = 50;

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup must not subscribe the composer to every other room's draft
const drafts = new Map<string, ComposerDraft>();
const revision = $state({ value: 0 });

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
  revision.value += 1;
}

export function draftDocuments(): Record<string, unknown> {
  void revision.value;

  const entries = [...drafts.entries()]
    .filter(([, draft]) => draft.doc !== null && draft.doc !== undefined)
    .slice(-MAX_SYNCED_DRAFTS);
  return Object.fromEntries(entries.map(([roomId, draft]) => [roomId, draft.doc]));
}

export function adoptDraftDocuments(documents: Record<string, unknown>): void {
  for (const [roomId, doc] of Object.entries(documents)) {
    const existing = drafts.get(roomId);
    if (existing?.doc !== undefined && existing.doc !== null) continue;

    drafts.set(roomId, {
      doc,
      staged: existing?.staged ?? [],
      nextStagedId: existing?.nextStagedId ?? 0,
    });
  }
  revision.value += 1;
}
