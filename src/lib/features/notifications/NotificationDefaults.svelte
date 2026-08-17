<script lang="ts">
  import type { NotificationModeView } from '@/generated/NotificationModeView';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Select from '$lib/ui/primitives/Select.svelte';

  import { settingsChanges } from './notifications.svelte';
  import { canPresent, permission, requestPermission } from './present';

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
  let granted = $state(!canPresent() || permission() === 'granted');

  $effect(() => {
    void settingsChanges.version;

    let current = true;
    void core
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

    void core.setDefaultNotificationMode(isDirect, mode).catch(() => {
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
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            save(true, event.currentTarget.value as NotificationModeView);
          }}
        >
          {#each modes as mode (mode)}
            <option value={mode}>{$i18n.t(modeLabels[mode])}</option>
          {/each}
        </Select>
      {/if}
    </label>
    <label>
      <span>{$i18n.t('settings.notificationDefaultGroup')}</span>
      {#if group}
        <Select
          aria-label={$i18n.t('settings.notificationDefaultGroup')}
          value={group}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            save(false, event.currentTarget.value as NotificationModeView);
          }}
        >
          {#each modes as mode (mode)}
            <option value={mode}>{$i18n.t(modeLabels[mode])}</option>
          {/each}
        </Select>
      {/if}
    </label>
  </div>
</section>

<style>
  .defaults {
    display: grid;
    gap: var(--space-2);
  }

  h3 {
    font-size: var(--font-size-medium);
    margin: 0;
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rows {
    display: grid;
    gap: var(--space-2);
  }

  label {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  @media (width < 32rem) {
    label {
      align-items: stretch;
      flex-direction: column;
      gap: var(--space-1);
    }
  }
</style>
