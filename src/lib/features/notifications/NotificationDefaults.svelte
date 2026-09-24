<script lang="ts">
  import type { DefaultNotificationModesView, NotificationModeView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';

  import { settingsChanges } from './notifications.svelte';
  import { grantPermission, permissionGranted } from './present';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const modes: NotificationModeView[] = ['all', 'mentions', 'mute'];
  const modeLabels: Record<NotificationModeView, string> = {
    all: 'room.notifyAll',
    mentions: 'room.notifyMentions',
    mute: 'room.notifyMute',
  };

  const rows: {
    key: keyof DefaultNotificationModesView;
    label: string;
    direct: boolean;
  }[] = [
    { key: 'direct', label: 'settings.notificationDefaultDirect', direct: true },
    { key: 'group', label: 'settings.notificationDefaultGroup', direct: false },
  ];

  let current = $state<DefaultNotificationModesView | null>(null);
  let failed = $state(false);
  let granted = $state(true);

  $effect(() => {
    let alive = true;
    void permissionGranted().then((allowed) => {
      if (alive) granted = allowed;
    });

    return () => {
      alive = false;
    };
  });

  $effect(() => {
    void settingsChanges.version;

    let alive = true;
    void core.commands
      .defaultNotificationModes()
      .then((modes) => {
        if (!alive) return;
        current = modes;
        failed = false;
      })
      .catch(() => {
        if (alive) failed = true;
      });

    return () => {
      alive = false;
    };
  });

  function save(
    key: keyof DefaultNotificationModesView,
    isDirect: boolean,
    mode: NotificationModeView
  ): void {
    if (current) current = { ...current, [key]: mode };

    void core.commands.setDefaultNotificationMode(isDirect, mode).catch(() => {
      failed = true;
    });
  }
</script>

<section class="defaults settings-form" aria-labelledby="notification-defaults">
  <div class="settings-heading-row">
    <h3 id="notification-defaults" data-settings-outline>
      {$i18n.t('settings.notificationDefaults')}
    </h3>
    <SettingsAnchorLink anchor="notification-defaults" />
  </div>
  <p class="hint">{$i18n.t('settings.notificationDefaultsHint')}</p>

  {#if !granted}
    <Alert variant="info">
      <p>{$i18n.t('settings.notificationPermission')}</p>
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          void grantPermission().then((allowed) => {
            granted = allowed;
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
    {#each rows as { key, label, direct } (key)}
      <label>
        <span>{$i18n.t(label)}</span>
        {#if current}
          <Select
            aria-label={$i18n.t(label)}
            value={current[key]}
            items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
            onValueChange={(value) => {
              save(key, direct, value as NotificationModeView);
            }}
          />
        {/if}
      </label>
    {/each}
  </div>
</section>

<style>
  .defaults {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
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
