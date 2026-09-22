import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./TimelineItem.svelte', import.meta.url), 'utf8');

test('keeps read receipts out of the message text column', () => {
  const content = source.match(/\.message-content \{(?<body>[^}]+)\}/u)?.groups?.body;
  const slot = source.match(/\.message-content > \.receipt-slot \{(?<body>[^}]+)\}/u)?.groups?.body;

  expect(content).toContain('grid-template-columns: minmax(0, 1fr);');
  expect(slot).toContain('grid-column: 1;');
});

test('reserves the receipt width on the last line it sits on', () => {
  const space = source.match(/\.receipt-space \{(?<body>[^}]+)\}/u)?.groups?.body;
  const inline = source.match(/\.has-receipts \.receipt-slot \{(?<body>[^}]+)\}/u)?.groups?.body;

  expect(space).toContain('inline-size: calc(var(--receipt-reserve) + var(--space-200));');
  expect(inline).toContain('position: absolute;');
  expect(inline).toContain('inset-block-end: 0;');
});
