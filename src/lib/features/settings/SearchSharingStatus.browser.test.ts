import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';
import SearchSharingStatus from './SearchSharingStatus.svelte';

test('sharing status fits desktop and narrow settings panels', async () => {
  Object.assign(core, {
    session: { account_id: 'account' },
    rpc: {
      search: {
        metrics: vi.fn(() =>
          Promise.resolve({
            sharing: {
              state: 'idle',
              pause: null,
              outcome: 'no_answer',
              peer: null,
              rooms_copied: 0,
              last_copy: { device_id: 'PHONE', name: 'Phone', at_ms: 0, rooms: 12 },
              automatic: true,
              asked: 2,
              candidates: [],
            },
          })
        ),
      },
    },
  });
  const screen = await render(SearchSharingStatus);
  await expect.element(screen.getByText('Ready')).toBeVisible();
  await expect.element(screen.getByText('Last copy')).toBeVisible();

  for (const width of [1280, 320]) {
    await page.viewport(width, 800);
    const status = document.getElementById('search-sharing-status');
    if (!status) throw new Error('Sharing status is missing');
    expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
});
