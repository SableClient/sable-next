<script lang="ts">
  import CloudArrowUpIcon from 'phosphor-svelte/lib/CloudArrowUpIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatTime } from '#lib/features/room/timeline-format.js';
  import { accountSync } from '#lib/settings/account-sync.svelte.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const status = $derived.by(() => {
    switch (accountSync.status) {
      case 'syncing':
        return $i18n.t('settings.syncStatusSyncing');
      case 'partial':
        return $i18n.t('settings.syncStatusPartial');
      case 'error':
        return $i18n.t('settings.syncStatusError');
      default:
        return accountSync.lastSyncedAt === null
          ? $i18n.t('settings.syncStatusNever')
          : $i18n.t('settings.syncStatusIdle', { time: formatTime(accountSync.lastSyncedAt) });
    }
  });
</script>

<ul class="settings">
  <SettingsRow
    title={$i18n.t('settings.syncStatusTitle')}
    description={status}
    icon={CloudArrowUpIcon}
  />
</ul>

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
