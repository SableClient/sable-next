<script lang="ts">
  import type { SearchBackupState, SearchBackupView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { formatBinarySize } from '#lib/ui/byte-size.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const REFRESH_MS = 5000;

  const core = useCoreClient();
  let backup = $state<SearchBackupView | null>(null);

  $effect(() => {
    if (core.session?.account_id === undefined) {
      backup = null;
      return;
    }

    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const metrics = await core.rpc.search.metrics();
        if (active) backup = metrics.backup;
      } catch {
        if (active) backup = null;
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
    waiting_for_wifi: 'settings.searchBackupStateWaitingForWifi',
    locked: 'settings.searchBackupStateLocked',
    working: 'settings.searchBackupStateWorking',
    idle: 'settings.searchBackupStateIdle',
    limit_reached: 'settings.searchBackupStateLimitReached',
    refused: 'settings.searchBackupStateRefused',
  };

  const stateVariants: Record<SearchBackupState, 'success' | 'warning' | 'critical' | 'neutral'> = {
    off: 'neutral',
    waiting_for_wifi: 'warning',
    locked: 'warning',
    working: 'success',
    idle: 'success',
    limit_reached: 'warning',
    refused: 'critical',
  };
</script>

{#if backup}
  <ul class="settings">
    <SettingsRow id="search-backup-status" title={i18n.t('settings.searchBackupStatus')}>
      <StatusBadge label={i18n.t(stateKeys[backup.state])} variant={stateVariants[backup.state]} />
    </SettingsRow>
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

  code {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    text-align: right;
  }
</style>
