import { parseMatrixHtml } from '#lib/features/composer/editor/schema.js';
import {
  composerMarkdown,
  serializePlain,
  textDoc,
} from '#lib/features/composer/editor/serialize.js';

export function bioMarkdown(html: string): string {
  return html === '' ? '' : composerMarkdown(parseMatrixHtml(html));
}

export function bioTexts(markdown: string): { body: string; mimetype?: string }[] {
  const { body, formatted } = serializePlain(textDoc(markdown));
  return formatted === null ? [{ body }] : [{ body: formatted, mimetype: 'text/html' }, { body }];
}
