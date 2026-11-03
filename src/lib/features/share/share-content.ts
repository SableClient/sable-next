import type { SharedBatch, SharedTarget } from '#lib/platform/share-target.js';

export interface ShareFileRef {
  batchId: string;
  fileName: string;
  mime: string | undefined;
}

// The iOS share extension opens the app with its own scheme, which differs between builds.
const SHARE_DEEP_LINK = /^(?:sable|moe\.sable\.next|moe\.sable\.app):\/\/share(?:[/?#]|$)/;

export function isShareDeepLink(url: string): boolean {
  return SHARE_DEEP_LINK.test(url);
}

export function mergeShareBatches(
  previous: readonly SharedBatch[],
  next: readonly SharedBatch[]
): SharedBatch[] {
  const known = new Set(previous.map((batch) => batch.batchId));
  return [...previous, ...next.filter((batch) => !known.has(batch.batchId))];
}

/** Only when every batch was shared to the same conversation. */
export function shareTarget(batches: readonly SharedBatch[]): SharedTarget | null {
  const target = batches[0]?.target;
  if (target === undefined) return null;
  const same = batches.every(
    (batch) => batch.target?.userId === target.userId && batch.target.roomId === target.roomId
  );
  return same ? target : null;
}

export function collectShareText(batches: readonly SharedBatch[]): string {
  return batches
    .flatMap((batch) => batch.items)
    .filter((item) => item.kind === 'text' || item.kind === 'url')
    .map((item) => item.text ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

export function collectShareFiles(batches: readonly SharedBatch[]): ShareFileRef[] {
  return batches.flatMap((batch) =>
    batch.items
      .filter((item) => item.kind === 'file' && item.fileName !== undefined)
      .map((item) => ({
        batchId: batch.batchId,
        fileName: item.fileName ?? '',
        mime: item.mime,
      }))
  );
}

export function displayFileName(stagedName: string): string {
  return stagedName.replace(/^\d+-/, '');
}

interface ProseMirrorDoc {
  type: 'doc';
  content: unknown[];
}

function paragraphs(text: string): unknown[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    ...(line === '' ? {} : { content: [{ type: 'text', text: line }] }),
  }));
}

export function plainTextDoc(text: string): ProseMirrorDoc {
  return { type: 'doc', content: paragraphs(text) };
}

export function appendPlainText(doc: unknown, text: string): ProseMirrorDoc {
  if (text === '') return isDoc(doc) ? doc : plainTextDoc('');
  if (!isDoc(doc)) return plainTextDoc(text);
  return { type: 'doc', content: [...doc.content, ...paragraphs(text)] };
}

function isDoc(value: unknown): value is ProseMirrorDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
