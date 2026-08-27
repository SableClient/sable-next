<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

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
  <div class="status-line">
    <span>{$i18n.t('settings.developerSyncState')}</span>
    <StatusBadge label={syncLabel} variant={badgeVariant} />
  </div>
  <dl>
    <div>
      <dt>{$i18n.t('settings.developerSyncCoreStatus')}</dt>
      <dd>{core.status}</dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSyncRooms')}</dt>
      <dd>{roomList.rooms.length}</dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSyncAccount')}</dt>
      <dd>{core.session?.account_id ?? '-'}</dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSyncRevision')}</dt>
      <dd>{core.accountRevision}</dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSyncUnresponsive')}</dt>
      <dd>
        {core.unresponsive ? $i18n.t('settings.developerYes') : $i18n.t('settings.developerNo')}
      </dd>
    </div>
  </dl>
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
    gap: var(--space-2);
  }

  .status-line,
  dl div {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
  }

  dl {
    display: grid;
    gap: var(--space-1);
    margin: 0;
  }

  dt,
  dd {
    margin: 0;
  }

  dt {
    color: var(--sable-surface-var-on-container);
  }

  dd {
    font-family: var(--font-family-mono);
    overflow-wrap: anywhere;
    text-align: right;
  }

  .error {
    color: var(--sable-crit-main);
    margin: 0;
  }
</style>
