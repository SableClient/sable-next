import type { SharedBatch } from '#lib/platform/share-target.js';

export interface ShareFileRef {
  batchId: string;
  fileName: string;
  mime: string | undefined;
}

export function isShareDeepLink(url: string): boolean {
  return url.startsWith('sable://share');
}

export function mergeShareBatches(
  previous: readonly SharedBatch[],
  next: readonly SharedBatch[]
): SharedBatch[] {
  const known = new Set(previous.map((batch) => batch.batchId));
  return [...previous, ...next.filter((batch) => !known.has(batch.batchId))];
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
