<script lang="ts">
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';

  import type { KeyBackupDownloadView, KeyBackupStatusView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  let { onUnlock }: { onUnlock: () => void } = $props();
  const core = useCoreClient();
  let status = $state<KeyBackupStatusView | null>(null);
  let download = $state<KeyBackupDownloadView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let requesting = $state(false);
  let refresh: () => Promise<void> = async () => {};
  let busy = $derived(
    requesting || download?.state === 'downloading' || download?.state === 'importing'
  );
  let progressLabel = $derived(
    download?.state === 'downloading'
      ? $i18n.t('settings.keyBackupDownloading')
      : $i18n.t('settings.keyBackupProgress', {
          processed: download?.processed ?? 0,
          total: download?.total ?? 0,
        })
  );

  $effect(() => {
    const accountId = core.session?.account_id;
    // Reload when recovery unlocks the backup.
    void core.encryption?.backup_unlocked;
    let active = true;
    let fetching = false;
    let downloadUpdates = 0;
    status = null;
    download = null;
    error = null;
    loading = true;
    requesting = false;
    refresh = async () => {
      if (fetching) return;
      fetching = true;
      const updates = downloadUpdates;
      try {
        const next = await core.commands.keyBackupStatus();
        if (!active) return;
        status = next;
        if (updates === downloadUpdates && !requesting) download = next.download;
        if (!download || download.state !== 'failed') error = null;
      } catch {
        if (active) error = t('settings.keyBackupStatusFailed');
      } finally {
        fetching = false;
        if (active) loading = false;
      }
    };
    const unsubscribe = core.subscribeEvents((event) => {
      if (
        !active ||
        event.type !== 'key_backup_download' ||
        event.download.account_id !== accountId
      )
        return;
      downloadUpdates += 1;
      download = event.download;
      if (download.state === 'failed') error = t('settings.keyBackupDownloadFailed');
      if (download.state === 'complete' || download.state === 'failed') void refresh();
    });
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  });

  async function restore(): Promise<void> {
    if (busy || !status?.can_restore) return;
    const accountId = core.session?.account_id;
    const requestId = crypto.randomUUID();
    requesting = true;
    error = null;
    download = {
      account_id: accountId ?? '',
      request_id: requestId,
      state: 'downloading',
      total: null,
      processed: 0,
      imported: 0,
      failed: 0,
    };
    try {
      const result = await core.commands.downloadKeyBackup(requestId);
      if (core.session?.account_id !== accountId) return;
      download = result;
      await refresh();
    } catch {
      if (core.session?.account_id !== accountId) return;
      if (download?.request_id === requestId) download = { ...download, state: 'failed' };
      error = t('settings.keyBackupDownloadFailed');
    } finally {
      if (core.session?.account_id === accountId) requesting = false;
    }
  }
</script>

<SettingsSection headingId="key-backup-heading" title={$i18n.t('settings.keyBackupTitle')}>
  {#snippet titleActions()}
    <IconButton
      variant="subtle"
      size="small"
      label={$i18n.t('settings.refresh')}
      disabled={loading || busy}
      onclick={() => void refresh()}
    >
      <ArrowClockwiseIcon />
    </IconButton>
  {/snippet}
  <div class="backup-settings">
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    {#if status}
      <div class="backup-counts">
        <p>
          {status.cloud_keys === null
            ? $i18n.t('settings.keyBackupDisabled')
            : $i18n.t('settings.keyBackupCloudCount', { count: status.cloud_keys })}
        </p>
        <p class="secondary">
          {$i18n.t('settings.keyBackupLocalCount', { count: status.local_keys })}
        </p>
        {#if status.cloud_keys !== null}
          <p class="secondary">
            {$i18n.t('settings.keyBackupUploadCount', {
              backedUp: status.backed_up_keys,
              total: status.local_keys,
            })}
          </p>
          {#if !status.can_restore}<p class="secondary">
              {$i18n.t('settings.keyBackupLocked')}
            </p>{/if}
        {/if}
      </div>
    {:else if loading}
      <p role="status">{$i18n.t('settings.keyBackupLoading')}</p>
    {/if}
    {#if download}
      <div class="download-status">
        {#if busy}
          <p role="status">{progressLabel}</p>
          {#if download.total !== null}
            <Progress
              value={download.total === 0
                ? 100
                : Math.min(100, (download.processed / download.total) * 100)}
              label={progressLabel}
            />
          {:else}
            <progress aria-label={progressLabel}></progress>
          {/if}
        {:else if download.state === 'complete'}
          <p role="status">
            {$i18n.t('settings.keyBackupRestored', {
              downloaded: download.processed - download.failed,
              total: download.total,
            })}
          </p>
          <p class="secondary">
            {$i18n.t('settings.keyBackupImported', { count: download.imported })}
          </p>
        {/if}
        {#if download.failed > 0}
          <Alert variant="warning"
            >{$i18n.t('settings.keyBackupInvalidKeys', { count: download.failed })}</Alert
          >
        {/if}
      </div>
    {/if}
    {#if status && status.cloud_keys !== null}
      <div class="backup-actions">
        {#if status.can_restore}
          <Button variant="secondary" size="small" loading={busy} onclick={() => void restore()}
            >{$i18n.t('settings.keyBackupDownload')}</Button
          >
        {:else}
          <Button variant="secondary" size="small" onclick={onUnlock}
            >{$i18n.t('settings.recoveryIncompleteAction')}</Button
          >
        {/if}
      </div>
    {/if}
  </div>
</SettingsSection>

<style>
  .backup-settings {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  .backup-counts,
  .download-status {
    display: grid;
    gap: var(--space-100);
  }

  p {
    font-variant-numeric: tabular-nums;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .secondary {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .backup-actions {
    display: flex;
  }

  progress {
    accent-color: var(--primary-main);
    block-size: var(--space-300);
    inline-size: 100%;
  }
</style>
