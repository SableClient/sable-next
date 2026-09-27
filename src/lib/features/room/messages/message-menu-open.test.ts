import { expect, test } from 'vitest';

import { OpenMessageMenu } from './message-menu-open.svelte.js';

test('opening a row menu closes whichever row held it', () => {
  const openMessageMenu = new OpenMessageMenu();
  openMessageMenu.set('first', true);
  expect(openMessageMenu.isOpen('first')).toBe(true);

  openMessageMenu.set('second', true);

  expect(openMessageMenu.isOpen('second')).toBe(true);
  expect(openMessageMenu.isOpen('first')).toBe(false);
});

test('a row closing its own menu does not close the row that now holds it', () => {
  const openMessageMenu = new OpenMessageMenu();
  openMessageMenu.set('first', true);
  openMessageMenu.set('second', true);

  openMessageMenu.set('first', false);

  expect(openMessageMenu.isOpen('second')).toBe(true);
});
