<script lang="ts">
  import BellIcon from 'phosphor-svelte/lib/BellIcon';

  import type { NotificationView } from '#src/generated/NotificationView';

  import { useNotificationCenter } from '#lib/features/notifications/notifications.svelte.js';
  import { permission, requestPermission } from '#lib/features/notifications/present.js';
  import { i18n } from '#lib/i18n.js';
  import {
    alertsNatively,
    sendNativeTestNotification,
  } from '#lib/platform/native-notifications.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const notifications = useNotificationCenter();

  let sequence = $state(0);
  let failed = $state(false);

  function view(count: number): NotificationView {
    return {
      user_id: '@sable:notification.test',
      room_id: '!notification:notification.test',
      event_id: `$notification-test-${String(count)}`,
      room_name: $i18n.t('settings.developerNotificationsRoom'),
      room_avatar_url: null,
      is_direct: false,
      encrypted: false,
      sender: '@sable:notification.test',
      sender_name: 'Sable',
      sender_avatar_url: null,
      body: $i18n.t('settings.developerNotificationsBody', { count }),
      mention: false,
      noisy: false,
    };
  }

  async function alert(): Promise<void> {
    sequence += 1;
    failed = false;

    try {
      if (alertsNatively()) {
        await sendNativeTestNotification(sequence);
        return;
      }
      if (permission() === 'default') await requestPermission();
      notifications.present(view(sequence));
    } catch {
      failed = true;
    }
  }
</script>

<ul class="settings">
  <SettingsRow
    title={$i18n.t('settings.developerNotificationsTitle')}
    description={$i18n.t('settings.developerNotificationsDescription')}
    icon={BellIcon}
  >
    <Button variant="secondary" size="small" onclick={() => void alert()}>
      {$i18n.t('settings.developerNotificationsSend')}
    </Button>
  </SettingsRow>
</ul>
{#if failed}
  <Alert variant="critical">{$i18n.t('settings.developerNotificationsFailed')}</Alert>
{/if}
