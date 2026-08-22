import type { StagedFile } from './composer-files';

export interface ComposerDraft {
  doc: unknown;
  staged: StagedFile[];
  nextStagedId: number;
}

const drafts = new Map<string, ComposerDraft>();

export function readDraft(roomId: string): ComposerDraft | undefined {
  return drafts.get(roomId);
}

export function writeDraft(roomId: string, draft: ComposerDraft): void {
  drafts.set(roomId, draft);
}

export function clearDraft(roomId: string): void {
  drafts.delete(roomId);
}

export function clearDrafts(): void {
  drafts.clear();
}
