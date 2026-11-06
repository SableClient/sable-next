<script lang="ts">
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import type { Component } from 'svelte';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import DevicesIcon from 'phosphor-svelte/lib/DevicesIcon';
  import type { IconComponentProps } from 'phosphor-svelte';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import type { UtdCauseView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import UserSecurityDialog from '../members/UserSecurityDialog.svelte';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.ts';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.ts';
  import ResponsiveInfoDialog from '#lib/ui/primitives/ResponsiveInfoDialog.svelte';

  const KEYS: Record<UtdCauseView, string> = {
    unknown: 'waiting',
    sent_before_we_joined: 'sentBeforeWeJoined',
    verification_violation: 'verificationViolation',
    unsigned_device: 'unsignedDevice',
    unknown_device: 'unknownDevice',
    historical_message_backup_disabled: 'historicalMessageBackupDisabled',
    historical_message_device_unverified: 'historicalMessageDeviceUnverified',
    withheld_for_unverified_or_insecure_device: 'withheldUnverified',
    withheld_by_sender: 'withheld',
  };

  const ICONS: Record<UtdCauseView, Component<IconComponentProps>> = {
    unknown: ClockIcon,
    sent_before_we_joined: ProhibitIcon,
    verification_violation: ShieldWarningIcon,
    unsigned_device: ShieldWarningIcon,
    unknown_device: DevicesIcon,
    historical_message_backup_disabled: ClockCounterClockwiseIcon,
    historical_message_device_unverified: ClockCounterClockwiseIcon,
    withheld_for_unverified_or_insecure_device: LockSimpleIcon,
    withheld_by_sender: ProhibitIcon,
  };

  const CRITICAL: UtdCauseView[] = ['unsigned_device', 'verification_violation'];

  interface Props {
    cause: UtdCauseView;
    userId: string;
    displayName: string;
  }

  let { cause, userId, displayName }: Props = $props();
  let critical = $derived(CRITICAL.includes(cause));
  let detailsOpen = $state(false);
  let securityOpen = $state(false);
</script>

{const Icon = ICONS[cause]}

<button
  type="button"
  class={['btn', 'undecryptable', { critical }]}
  onclick={() => {
    detailsOpen = true;
  }}
>
  <Icon weight={critical ? 'fill' : 'regular'} />
  <span>{i18n.t(`timeline.utd.title.${KEYS[cause]}`, { name: displayName })}</span>
</button>

<ResponsiveInfoDialog
  bind:open={detailsOpen}
  label={i18n.t('timeline.utd.detailsTitle')}
  closeLabel={i18n.t('common.close')}
>
  {#snippet header()}
    <Icon />
    <h2>{i18n.t(`timeline.utd.title.${KEYS[cause]}`, { name: displayName })}</h2>
  {/snippet}

  {#snippet body(desktop)}
    <p>{i18n.t(`timeline.utd.details.${KEYS[cause]}`, { name: displayName })}</p>
    {#if i18n.exists(`timeline.utd.cause.${KEYS[cause]}`)}
      <h3>{i18n.t('timeline.utd.causeHeader')}</h3>
      <p>{i18n.t(`timeline.utd.cause.${KEYS[cause]}`, { name: displayName })}</p>
    {/if}
    {#if cause === 'verification_violation'}
      <Button
        variant="primary"
        size="small"
        block={!desktop}
        onclick={() => {
          detailsOpen = false;
          securityOpen = true;
        }}
      >
        {i18n.t('timeline.utd.openIdentitySettings')}
      </Button>
    {:else if cause === 'historical_message_backup_disabled' || cause === 'historical_message_device_unverified' || cause === 'withheld_for_unverified_or_insecure_device'}
      <Button
        variant="primary"
        size="small"
        block={!desktop}
        onclick={(event) => {
          detailsOpen = false;
          openSettingsOver(event, SETTINGS_DEVICES_SECTION);
        }}
      >
        {i18n.t(
          cause === 'historical_message_backup_disabled'
            ? 'timeline.utd.enableKeyBackup'
            : 'timeline.utd.confirmThisDevice'
        )}
      </Button>
    {/if}
  {/snippet}
</ResponsiveInfoDialog>

<UserSecurityDialog
  open={securityOpen}
  {userId}
  {displayName}
  onOpenChange={(next) => (securityOpen = next)}
/>

<style>
  .undecryptable {
    align-items: center;
    background-color: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    margin: 0;
    margin-top: var(--space-100);
    max-width: 32rem;
    padding: var(--space-100) var(--space-200);
    width: fit-content;

    :global(svg) {
      height: var(--size-x50);
      width: var(--size-x50);
    }

    &:hover {
      cursor: pointer;

      /* background-color: var(--surface-var-container-hover); */
    }
  }

  .undecryptable.critical :global(svg) {
    fill: var(--crit-main);
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  h3 {
    font-size: var(--font-size-label);
    margin: 0;
  }
</style>
