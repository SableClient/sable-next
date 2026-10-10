import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { KeyBackupDownloadView, KeyBackupStatusView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';

import KeyBackupSettings from './KeyBackupSettings.svelte';

test('cloud backup counts, manual restore and the settings layout', async () => {
  let download: KeyBackupDownloadView | null = null;
  const status = (): KeyBackupStatusView => ({
    local_keys: download?.state === 'complete' ? 200 : 120,
    backed_up_keys: download?.state === 'complete' ? 200 : 120,
    cloud_keys: 200,
    can_restore: true,
    download,
  });
  Object.assign(core, {
    session: { account_id: 'a1' },
    encryption: null,
    subscribeEvents: vi.fn(() => () => {}),
    keyBackupStatus: vi.fn(() => Promise.resolve(status())),
    downloadKeyBackup: vi.fn((requestId: string) => {
      download = {
        account_id: 'a1',
        request_id: requestId,
        state: 'complete',
        total: 200,
        processed: 200,
        imported: 80,
        failed: 0,
      };
      return Promise.resolve(download);
    }),
  });
  core.commands = core;

  const screen = await render(KeyBackupSettings, { onUnlock: vi.fn() });
  await expect.element(screen.getByText('200 keys in the cloud')).toBeVisible();
  await expect.element(screen.getByText('120 keys on this device')).toBeVisible();

  await userEvent.click(screen.getByRole('button', { name: 'Download keys' }));
  await expect.element(screen.getByText('Restored 200 of 200 keys.')).toBeVisible();
  await expect.element(screen.getByText('80 keys added or updated on this device.')).toBeVisible();
  await expect.element(screen.getByText('200 keys on this device')).toBeVisible();

  const region = screen.getByRole('region', { name: 'Cloud key backup' }).element();
  expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
});
