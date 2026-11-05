<script lang="ts">
  import type {
    SearchBackupActivity,
    SearchBackupState,
    SearchBackupView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { formatBinarySize } from '#lib/ui/byte-size.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const REFRESH_MS = 1000;

  const core = useCoreClient();
  let backup = $state<SearchBackupView | null>(null);

  $effect(() => {
    if (core.session?.account_id === undefined) {
      backup = null;
      return;
    }

    backup = null;
    let active = true;
    let fetching = false;
    const refresh = async (): Promise<void> => {
      if (fetching) return;
      fetching = true;
      try {
        const metrics = await core.rpc.search.metrics();
        if (active) backup = metrics.backup;
      } catch {
        if (active) backup = null;
      } finally {
        fetching = false;
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  });

  const stateKeys: Record<SearchBackupState, string> = {
    off: 'settings.searchBackupStateOff',
    scheduled: 'settings.searchBackupStateScheduled',
    failed: 'settings.searchBackupStateFailed',
    waiting_for_wifi: 'settings.searchBackupStateWaitingForWifi',
    locked: 'settings.searchBackupStateLocked',
    working: 'settings.searchBackupStateWorking',
    idle: 'settings.searchBackupStateIdle',
    limit_reached: 'settings.searchBackupStateLimitReached',
    refused: 'settings.searchBackupStateRefused',
  };

  const stateVariants: Record<SearchBackupState, 'success' | 'warning' | 'critical' | 'neutral'> = {
    off: 'neutral',
    scheduled: 'neutral',
    failed: 'warning',
    waiting_for_wifi: 'warning',
    locked: 'warning',
    working: 'success',
    idle: 'success',
    limit_reached: 'warning',
    refused: 'critical',
  };
  const activityKeys: Record<SearchBackupActivity, string> = {
    checking: 'settings.searchBackupChecking',
    preparing: 'settings.searchBackupPreparing',
    downloading: 'settings.searchBackupDownloading',
    importing: 'settings.searchBackupImporting',
    uploading: 'settings.searchBackupUploading',
    publishing: 'settings.searchBackupPublishing',
    cleaning: 'settings.searchBackupCleaning',
  };
  let progress = $derived(backup?.progress);
  let transferring = $derived(
    progress?.activity === 'uploading' || progress?.activity === 'downloading'
  );
  let percent = $derived(
    transferring && progress && progress.parts_total > 0
      ? Math.min(100, Math.floor((progress.parts_done / progress.parts_total) * 100))
      : null
  );
  let activityLabel = $derived(progress ? i18n.t(activityKeys[progress.activity]) : '');
</script>

{#if backup}
  <ul class="settings">
    <SettingsRow id="search-backup-status" title={i18n.t('settings.searchBackupStatus')}>
      <StatusBadge
        label={backup.state === 'working' && progress
          ? activityLabel
          : i18n.t(stateKeys[backup.state])}
        variant={stateVariants[backup.state]}
      />
    </SettingsRow>
    {#if backup.state === 'working' && progress?.room}
      <SettingsRow id="search-backup-progress" title={progress.room} wide>
        <div class="transfer-progress">
          <Progress value={percent} label={activityLabel} />
          {#if percent !== null}
            <span class="transfer-counts">
              {i18n.t('settings.searchBackupParts', {
                completed: progress.parts_done,
                total: progress.parts_total,
                percent,
              })}
            </span>
          {/if}
          {#if transferring && progress.transferred_bytes > 0}
            <span class="transfer-counts">
              {progress.total_bytes === null
                ? i18n.t('settings.searchBackupTransferred', {
                    value: formatBinarySize(progress.transferred_bytes),
                  })
                : i18n.t('settings.developerSearchBytes', {
                    value: formatBinarySize(progress.transferred_bytes),
                    total: formatBinarySize(progress.total_bytes),
                  })}
            </span>
          {/if}
        </div>
      </SettingsRow>
    {/if}
    {#if backup.next_run_ms !== null && backup.state !== 'off'}
      <SettingsRow
        id="search-backup-next-check"
        title={i18n.t('settings.searchBackupNextCheck')}
        description={i18n.t('settings.searchBackupScheduleHint')}
      >
        <span>{new Date(backup.next_run_ms).toLocaleTimeString(currentLocale())}</span>
      </SettingsRow>
    {/if}
    <SettingsRow id="search-backup-usage" title={i18n.t('settings.searchBackupUsage')}>
      <code>
        {i18n.t('settings.developerSearchBytes', {
          value: formatBinarySize(backup.published_bytes),
          total: formatBinarySize(backup.limit_bytes),
        })}
      </code>
    </SettingsRow>
    <SettingsRow id="search-backup-shared" title={i18n.t('settings.searchBackupRoomsShared')}>
      <code>{backup.rooms_published}</code>
    </SettingsRow>
    <SettingsRow id="search-backup-received" title={i18n.t('settings.searchBackupRoomsReceived')}>
      <code>{backup.rooms_imported}</code>
    </SettingsRow>
  </ul>
{/if}

<style>
  .settings {
    border-top: var(--border-width) solid var(--bg-container-line);
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .transfer-progress {
    display: grid;
    gap: var(--space-100);
    inline-size: min(16rem, 100%);
    min-inline-size: min(12rem, 100%);
  }

  .transfer-counts {
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
    text-align: end;
  }

  code {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    text-align: right;
  }
</style>
