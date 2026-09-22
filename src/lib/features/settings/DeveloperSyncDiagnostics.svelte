<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();
  let syncState = $derived(core.sync?.state ?? 'offline');
  let syncLabel = $derived(
    syncState === 'live'
      ? $i18n.t('settings.developerSyncLive')
      : syncState === 'syncing'
        ? $i18n.t('settings.developerSyncSyncing')
        : syncState === 'error'
          ? $i18n.t('settings.developerSyncError')
          : $i18n.t('settings.developerSyncOffline')
  );
  let badgeVariant: 'success' | 'critical' | 'warning' = $derived(
    syncState === 'live' ? 'success' : syncState === 'error' ? 'critical' : 'warning'
  );
</script>

<div class="diagnostics">
  <ul class="settings">
    <SettingsRow title={$i18n.t('settings.developerSyncState')}>
      <StatusBadge label={syncLabel} variant={badgeVariant} />
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSyncCoreStatus')}>
      <code>{core.status}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSyncRooms')}>
      <code>{roomList.rooms.length}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSyncAccount')}>
      <code>{core.session?.account_id ?? '-'}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSyncRevision')}>
      <code>{core.accountRevision}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSyncUnresponsive')}>
      <code>
        {core.unresponsive ? $i18n.t('settings.developerYes') : $i18n.t('settings.developerNo')}
      </code>
    </SettingsRow>
  </ul>
  {#if core.sync?.state === 'error'}
    <p class="error">{core.sync.message}</p>
  {/if}
  {#if core.crashed}
    <p class="error">{core.crashed}</p>
  {/if}
</div>

<style>
  .diagnostics {
    display: grid;
    gap: var(--space-300);
  }

  .settings {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  code {
    font-family: var(--font-family-mono);
    overflow-wrap: anywhere;
    text-align: right;
  }

  .error {
    color: var(--crit-main);
    margin: 0;
  }
</style>
