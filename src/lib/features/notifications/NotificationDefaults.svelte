<script lang="ts">
  import type { NotificationModeView } from '#src/generated/NotificationModeView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { presentsInApp } from '#lib/platform/notifications.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';

  import { settingsChanges } from './notifications.svelte';
  import { permission, requestPermission } from './present';

  const core = useCoreClient();
  const modes: NotificationModeView[] = ['all', 'mentions', 'mute'];
  const modeLabels: Record<NotificationModeView, string> = {
    all: 'room.notifyAll',
    mentions: 'room.notifyMentions',
    mute: 'room.notifyMute',
  };

  let direct = $state<NotificationModeView | null>(null);
  let group = $state<NotificationModeView | null>(null);
  let failed = $state(false);
  let granted = $state(!presentsInApp() || permission() === 'granted');

  $effect(() => {
    void settingsChanges.version;

    let current = true;
    void core.commands
      .defaultNotificationModes()
      .then((modes) => {
        if (!current) return;
        direct = modes.direct;
        group = modes.group;
        failed = false;
      })
      .catch(() => {
        if (current) failed = true;
      });

    return () => {
      current = false;
    };
  });

  function save(isDirect: boolean, mode: NotificationModeView): void {
    if (isDirect) direct = mode;
    else group = mode;

    void core.commands.setDefaultNotificationMode(isDirect, mode).catch(() => {
      failed = true;
    });
  }
</script>

<section class="defaults" aria-labelledby="notification-defaults">
  <h3 id="notification-defaults">{$i18n.t('settings.notificationDefaults')}</h3>
  <p class="hint">{$i18n.t('settings.notificationDefaultsHint')}</p>

  {#if !granted}
    <Alert variant="info">
      <p>{$i18n.t('settings.notificationPermission')}</p>
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          void requestPermission().then((result) => {
            granted = result === 'granted';
          });
        }}>{$i18n.t('settings.notificationPermissionAction')}</Button
      >
    </Alert>
  {/if}

  {#if failed}
    <Alert variant="warning" role="status">
      <p>{$i18n.t('settings.notificationDefaultsFailed')}</p>
    </Alert>
  {/if}

  <div class="rows">
    <label>
      <span>{$i18n.t('settings.notificationDefaultDirect')}</span>
      {#if direct}
        <Select
          aria-label={$i18n.t('settings.notificationDefaultDirect')}
          value={direct}
          items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
          onValueChange={(value) => {
            save(true, value as NotificationModeView);
          }}
        />
      {/if}
    </label>
    <label>
      <span>{$i18n.t('settings.notificationDefaultGroup')}</span>
      {#if group}
        <Select
          aria-label={$i18n.t('settings.notificationDefaultGroup')}
          value={group}
          items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
          onValueChange={(value) => {
            save(false, value as NotificationModeView);
          }}
        />
      {/if}
    </label>
  </div>
</section>

<style>
  .defaults {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rows {
    display: grid;
    gap: var(--space-300);
  }

  label {
    align-items: stretch;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    justify-content: space-between;
  }

  @media (width >= 32rem) {
    label {
      align-items: center;
      display: grid;
      gap: var(--space-400);
      grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    }
  }
</style>
