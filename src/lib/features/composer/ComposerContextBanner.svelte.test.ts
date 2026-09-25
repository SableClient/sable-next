import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./ComposerContextBanner.svelte', import.meta.url), 'utf8');

test('a long reply sender leaves room for the context actions', () => {
  const contextKind = source.match(/\.context-kind \{(?<contents>[^}]+)\}/u)?.groups?.contents;

  expect(contextKind).toContain('flex: 0 1 auto;');
  expect(contextKind).toContain('min-width: 0;');
  expect(contextKind).toContain('overflow: hidden;');
  expect(contextKind).toContain('text-overflow: ellipsis;');
  expect(contextKind).toContain('white-space: nowrap;');
});

test('a reply context shows a reply icon and sender with an accessible reply label', () => {
  expect(source).toContain("import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpRightIcon';");
  expect(source).toContain(
    '<span class="context-reply-icon" aria-hidden="true"><ReplyIcon /></span>'
  );
  expect(source).toContain('<span class="context-sender">{context.sender}</span>');
  expect(source).toMatch(
    /<span class="context-reply-icon" aria-hidden="true"><ReplyIcon \/><\/span>\s+<span class="context-sender">\{context\.sender\}<\/span>/u
  );
  expect(source).toContain(
    "aria-label={$i18n.t('composer.replyingTo', { name: context.sender ?? '' })}"
  );
});

test('the reply icon aligns with the composer plus icon', () => {
  const context = source.match(/\.context \{(?<contents>[^}]+)\}/u)?.groups?.contents;

  expect(context).toContain('margin-inline-start: calc(');
  expect(context).toContain(
    'var(--space-100) + (var(--control-height-small) - var(--icon-size-small)) / 2'
  );
});
