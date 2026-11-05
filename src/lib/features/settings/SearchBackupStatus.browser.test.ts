import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { SearchBackupView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';
import SearchBackupStatus from './SearchBackupStatus.svelte';

test('room transfer progress fits desktop and narrow settings panels', async () => {
  const backup: SearchBackupView = {
    state: 'working',
    progress: {
      activity: 'downloading',
      room: 'A community room with a long name for discussions and announcements',
      parts_done: 127,
      parts_total: 256,
      transferred_bytes: 50 * 1024 * 1024,
      total_bytes: 100 * 1024 * 1024,
    },
    next_run_ms: null,
    failures: 0,
    published_bytes: 50 * 1024 * 1024,
    limit_bytes: 100 * 1024 * 1024,
    rooms_published: 12,
    rooms_imported: 3,
  };
  Object.assign(core, {
    session: { account_id: 'account' },
    rpc: { search: { metrics: vi.fn(() => Promise.resolve({ backup })) } },
  });
  const screen = await render(SearchBackupStatus);
  await expect.element(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '49');
  await expect.element(screen.getByText('127 of 256 parts · 49%')).toBeVisible();

  for (const width of [1280, 320]) {
    await page.viewport(width, 800);
    const progress = document.getElementById('search-backup-progress');
    if (!progress) throw new Error('Room transfer progress is missing');
    expect(progress.scrollWidth).toBeLessThanOrEqual(progress.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const track = screen.getByRole('progressbar').element().getBoundingClientRect();
    expect(track.width).toBeGreaterThan(100);
    expect(track.right).toBeLessThanOrEqual(width);
  }
});
