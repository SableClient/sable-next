<script lang="ts">
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
  import CircleDashedIcon from 'phosphor-svelte/lib/CircleDashedIcon';

  import type { NotificationModeView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { permissionState } from '#lib/features/notifications/present.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    active: boolean;
    onComplete: () => void;
  }

  let { active, onComplete }: Props = $props();
  const core = useCoreClient();
  let notifying = $state(false);
  let groupMode = $state<NotificationModeView | null>(null);

  $effect(() => {
    if (!active) return;
    let alive = true;
    void permissionState().then((state) => {
      if (alive) notifying = state === 'granted' && preferences.systemNotifications;
    });
    void core.commands.defaultNotificationModes().then(
      ({ group }) => {
        if (alive) groupMode = group;
      },
      () => undefined
    );
    return () => {
      alive = false;
    };
  });

  const items = $derived([
    {
      done: core.encryption?.verification === 'verified',
      yes: 'setup.doneConfirmed',
      no: 'setup.doneUnconfirmed',
    },
    {
      done: core.encryption?.recovery === 'enabled',
      yes: 'setup.doneRecovery',
      no: 'setup.doneNoRecovery',
    },
    { done: notifying, yes: 'setup.doneNotifying', no: 'setup.doneNotNotifying' },
    ...(groupMode
      ? [
          {
            done: groupMode !== 'mute',
            yes: groupMode === 'all' ? 'setup.doneGroupAll' : 'setup.doneGroupMentions',
            no: 'setup.doneGroupMuted',
          },
        ]
      : []),
    { done: preferences.settingsSync, yes: 'setup.doneSyncing', no: 'setup.doneNotSyncing' },
  ]);
</script>

<div class="setup-done-card auth-card-surface">
  <AuthField labelId="setup-done-title" label={$i18n.t('setup.doneTitle')}>
    <ul class="setup-done-list">
      {#each items as item (item.yes)}
        <li class:done={item.done}>
          {#if item.done}
            <CheckCircleIcon aria-hidden="true" weight="fill" />
          {:else}
            <CircleDashedIcon aria-hidden="true" />
          {/if}
          {$i18n.t(item.done ? item.yes : item.no)}
        </li>
      {/each}
    </ul>
  </AuthField>
  <p class="setup-done-hint">{$i18n.t('setup.doneHint')}</p>

  <AuthStatusSlot />

  <Button variant="primary" block onclick={onComplete}>{$i18n.t('setup.doneAction')}</Button>
</div>

<style>
  .setup-done-card {
    min-width: 0;
  }

  .setup-done-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .setup-done-list li {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    gap: var(--space-200);
  }

  .setup-done-list li.done {
    color: inherit;
  }

  .setup-done-list li.done :global(svg) {
    color: var(--success-main);
  }

  .setup-done-list :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .setup-done-card .setup-done-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
