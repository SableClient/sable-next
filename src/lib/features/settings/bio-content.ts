import { parseMatrixHtml } from '#lib/features/composer/editor/schema.js';
import { serializeComposer } from '#lib/features/composer/editor/serialize.js';

export interface BioContent {
  body: string;
  formatted: string | null;
}

export function bioContent(html: string): BioContent {
  const { body, formatted } = serializeComposer(parseMatrixHtml(html));
  return { body, formatted };
}

export function bioTexts({ body, formatted }: BioContent): { body: string; mimetype?: string }[] {
  return formatted === null ? [{ body }] : [{ body: formatted, mimetype: 'text/html' }, { body }];
}

export function bioHtml({ body, formatted }: BioContent): string | null {
  if (body === '') return null;
  return (
    formatted ??
    `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replaceAll('\n', '<br>')}</p>`
  );
}
