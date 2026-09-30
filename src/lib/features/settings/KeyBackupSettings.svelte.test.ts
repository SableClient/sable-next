// @vitest-environment happy-dom

import { act, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  CoreEvent,
  KeyBackupDownloadView,
  KeyBackupStatusView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
import { core as baseCore } from '#lib/core/__mocks__/context.js';
import KeyBackupSettings from './KeyBackupSettings.svelte';

const core = Object.assign(baseCore, {
  session: { account_id: 'a1' },
  encryption: null,
  subscribeEvents: vi.fn<(callback: (event: CoreEvent) => void) => () => void>(),
  keyBackupStatus: vi.fn<() => Promise<KeyBackupStatusView>>(),
  downloadKeyBackup: vi.fn<(requestId: string) => Promise<KeyBackupDownloadView>>(),
});
let listener: (event: CoreEvent) => void;
const unsubscribe = vi.fn();
const onUnlock = vi.fn();
const available: KeyBackupStatusView = {
  local_keys: 12,
  backed_up_keys: 9,
  cloud_keys: 30,
  can_restore: true,
  download: null,
};
function progress(overrides: Partial<KeyBackupDownloadView> = {}): KeyBackupDownloadView {
  return {
    account_id: 'a1',
    request_id: 'request',
    state: 'importing',
    total: 30,
    processed: 10,
    imported: 4,
    failed: 0,
    ...overrides,
  };
}
beforeEach(() => {
  core.session = { account_id: 'a1' };
  core.keyBackupStatus.mockReset().mockResolvedValue(available);
  core.downloadKeyBackup.mockReset();
  core.subscribeEvents.mockImplementation((callback: (event: CoreEvent) => void) => {
    listener = callback;
    return unsubscribe;
  });
  onUnlock.mockClear();
  unsubscribe.mockClear();
});

test('shows independent cloud, local, and uploaded counts', async () => {
  render(KeyBackupSettings, { onUnlock });
  expect(await screen.findByText('30 keys in the cloud')).toBeInTheDocument();
  expect(screen.getByText('12 keys on this device')).toBeInTheDocument();
  expect(screen.getByText('9 of 12 local keys backed up')).toBeInTheDocument();
});

test('offers recovery for a locked backup and no download when no backup exists', async () => {
  core.keyBackupStatus.mockResolvedValue({ ...available, can_restore: false });
  const { unmount } = render(KeyBackupSettings, { onUnlock });
  await userEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
  expect(onUnlock).toHaveBeenCalledOnce();
  expect(core.downloadKeyBackup).not.toHaveBeenCalled();
  unmount();
  core.keyBackupStatus.mockResolvedValue({ ...available, cloud_keys: null, can_restore: false });
  render(KeyBackupSettings, { onUnlock });
  expect(await screen.findByText(/No cloud key backup/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download keys' })).toBeNull();
});

test('downloads once, reports progress, and distinguishes existing keys from new imports', async () => {
  let finish!: (download: KeyBackupDownloadView) => void;
  core.downloadKeyBackup.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  render(KeyBackupSettings, { onUnlock });
  const button = await screen.findByRole('button', { name: 'Download keys' });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  await act(() => {
    listener({ type: 'key_backup_download', download: progress() });
  });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33.33333333333333');
  const complete = progress({ state: 'complete', processed: 30, imported: 24 });
  core.keyBackupStatus.mockResolvedValue({ ...available, download: complete });
  await act(() => {
    finish(complete);
  });
  expect(await screen.findByText('Restored 30 of 30 keys.')).toBeInTheDocument();
  expect(screen.getByText('24 keys added or updated on this device.')).toBeInTheDocument();
  expect(core.downloadKeyBackup).toHaveBeenCalledOnce();
  expect(button).not.toBeDisabled();
});

test('keeps active progress when an older status response arrives', async () => {
  let finish!: (status: KeyBackupStatusView) => void;
  core.keyBackupStatus.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  render(KeyBackupSettings, { onUnlock });
  await act(() => {
    listener({ type: 'key_backup_download', download: progress() });
  });
  await act(() => {
    finish(available);
  });
  expect(await screen.findByText('Restoring 10 of 30 keys…')).toBeInTheDocument();
});

test('resumes progress when reopening settings and ignores another account', async () => {
  core.keyBackupStatus.mockResolvedValue({ ...available, download: progress() });
  const { unmount } = render(KeyBackupSettings, { onUnlock });
  await screen.findByText('Restoring 10 of 30 keys…');
  await act(() => {
    listener({
      type: 'key_backup_download',
      download: progress({ account_id: 'a2', processed: 20 }),
    });
  });
  expect(screen.getByText('Restoring 10 of 30 keys…')).toBeInTheDocument();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test('shows unreadable keys without claiming a complete successful restore', async () => {
  const complete = progress({ state: 'complete', processed: 30, imported: 20, failed: 2 });
  core.keyBackupStatus.mockResolvedValue({ ...available, download: complete });
  render(KeyBackupSettings, { onUnlock });
  expect(await screen.findByText(/Restored 28 of 30 keys/)).toBeInTheDocument();
  expect(screen.getByText(/2 keys could not be read/)).toBeInTheDocument();
});

test('can retry a failed download', async () => {
  core.downloadKeyBackup
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(progress({ state: 'complete', processed: 30 }));
  render(KeyBackupSettings, { onUnlock });
  const button = await screen.findByRole('button', { name: 'Download keys' });
  await userEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not download keys');
  await waitFor(() => expect(button).not.toBeDisabled());
  await userEvent.click(button);
  expect(core.downloadKeyBackup).toHaveBeenCalledTimes(2);
});

test('an unavailable server can be retried with refresh', async () => {
  core.keyBackupStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(available);
  render(KeyBackupSettings, { onUnlock });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load key backup status');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('30 keys in the cloud')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});
