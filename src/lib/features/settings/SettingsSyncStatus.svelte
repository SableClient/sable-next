<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { formatTime } from '#lib/ui/date-time.js';
  import { accountSync } from '#lib/settings/account-sync.svelte.js';
  import { SYNCED_THEME_LIMIT_MIB } from '#lib/settings/sync.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const status = $derived.by(() => {
    switch (accountSync.status) {
      case 'syncing':
        return $i18n.t('settings.syncStatusSyncing');
      case 'partial':
        return $i18n.t('settings.syncStatusPartial', {
          names: accountSync.skipped.join(', '),
          limit: SYNCED_THEME_LIMIT_MIB,
        });
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
  <SettingsRow id="sync-status" title={$i18n.t('settings.syncStatusTitle')} description={status} />
</ul>

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
