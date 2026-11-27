import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import AccountDataExplorer from './AccountDataExplorer.svelte';

const source = {
  types: () => Promise.resolve(['com.example.first', 'com.example.second']),
  read: () => Promise.resolve({ content: { a: 1 }, seal: 'plain' as const }),
  write: () => Promise.resolve(),
};

test('on a narrow screen focus moves to the editor and back to the event it came from', async () => {
  await page.viewport(390, 800);
  const screen = await render(AccountDataExplorer, { source, label: 'Account data' });

  await userEvent.click(screen.getByRole('button', { name: 'second' }));
  await expect.poll(() => document.activeElement?.classList.contains('detail-head')).toBe(true);

  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await expect.element(screen.getByRole('button', { name: 'second' })).toHaveFocus();
});

test('a filter that matches nothing says so instead of claiming there is no data', async () => {
  await page.viewport(1100, 800);
  const screen = await render(AccountDataExplorer, { source, label: 'Account data' });

  await userEvent.fill(screen.getByRole('searchbox'), 'zzz');
  await expect.element(screen.getByText('Nothing matches that filter.')).toBeVisible();
});
