// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import PageTitle from './PageTitle.svelte';

test('updates the title without replacing its place in the stack', async () => {
  const room = render(PageTitle, { title: 'General' });
  const settings = render(PageTitle, { title: 'Account' });

  await room.rerender({ title: 'General (1)' });
  expect(document.title).toBe('Account - Sable');

  await settings.rerender({ title: 'Appearance' });
  expect(document.title).toBe('Appearance - Sable');

  settings.unmount();
  expect(document.title).toBe('General (1) - Sable');
});

test('does not restore a page that unmounted below the current page', () => {
  document.title = 'Sable';
  const outgoing = render(PageTitle, { title: 'Account' });
  const incoming = render(PageTitle, { title: 'Appearance' });

  outgoing.unmount();
  expect(document.title).toBe('Appearance - Sable');

  incoming.unmount();
  expect(document.title).toBe('Sable');
});

test('tracks pages with identical titles independently', () => {
  document.title = 'General - Sable';
  const first = render(PageTitle, { title: 'Settings' });
  const second = render(PageTitle, { title: 'Settings' });

  first.unmount();
  expect(document.title).toBe('Settings - Sable');

  second.unmount();
  expect(document.title).toBe('General - Sable');
});
