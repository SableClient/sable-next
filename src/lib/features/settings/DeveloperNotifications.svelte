<script lang="ts">
  import type { NotificationView } from '#src/generated/protocol';

  import { useNotificationCenter } from '#lib/features/notifications/notifications.svelte.js';
  import { grantPermission, permissionGranted } from '#lib/features/notifications/present.js';
  import { i18n } from '#lib/i18n.js';
  import {
    alertsNatively,
    sendNativeTestNotification,
    takeNativePushDiagnostics,
    type NativePushDiagnostics,
  } from '#lib/platform/native-notifications.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const notifications = useNotificationCenter();

  let sequence = $state(0);
  let failed = $state(false);
  let diagnostics = $state<NativePushDiagnostics | null>();

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
      if (!(await permissionGranted()) && !(await grantPermission())) {
        failed = true;
        return;
      }
      if (alertsNatively()) {
        await sendNativeTestNotification(sequence);
        return;
      }
      notifications.present(view(sequence));
    } catch {
      failed = true;
    }
  }

  async function readOutcomes(): Promise<void> {
    diagnostics = (await takeNativePushDiagnostics()) ?? {
      counts: {},
      lastOutcome: null,
      lastAt: 0,
    };
  }

  let outcomes = $derived(Object.entries(diagnostics?.counts ?? {}).sort());
</script>

<ul class="settings">
  <SettingsRow
    title={$i18n.t('settings.developerNotificationsTitle')}
    description={$i18n.t('settings.developerNotificationsDescription')}
  >
    <Button variant="secondary" size="small" onclick={() => void alert()}>
      {$i18n.t('settings.developerNotificationsSend')}
    </Button>
  </SettingsRow>
  {#if alertsNatively()}
    <SettingsRow
      title={$i18n.t('settings.developerPushOutcomesTitle')}
      description={$i18n.t('settings.developerPushOutcomesDescription')}
    >
      <Button variant="secondary" size="small" onclick={() => void readOutcomes()}>
        {$i18n.t('settings.developerPushOutcomesRead')}
      </Button>
    </SettingsRow>
  {/if}
</ul>
{#if diagnostics}
  {#if outcomes.length === 0}
    <Alert variant="info">{$i18n.t('settings.developerPushOutcomesEmpty')}</Alert>
  {:else}
    <ul class="outcomes">
      {#each outcomes as [outcome, count] (outcome)}
        <li class:last={outcome === diagnostics.lastOutcome}>{outcome}: {count}</li>
      {/each}
    </ul>
  {/if}
{/if}
{#if failed}
  <Alert variant="critical">{$i18n.t('settings.developerNotificationsFailed')}</Alert>
{/if}

<style>
  .outcomes {
    display: grid;
    font-family: var(--font-family-mono);
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    padding: var(--space-200) 0 0;
  }

  .outcomes .last {
    font-weight: var(--font-weight-bold);
  }
</style>
