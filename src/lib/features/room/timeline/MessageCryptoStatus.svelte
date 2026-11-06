<script lang="ts">
  import { i18n } from '#lib/i18n.ts';
  import ResponsiveInfoDialog from '#lib/ui/primitives/ResponsiveInfoDialog.svelte';
  import type { MessageShieldCode, MessageShieldView } from '#src/generated/protocol';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';
  import LockSimpleOpenIcon from 'phosphor-svelte/lib/LockSimpleOpenIcon';
  import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import type { IconComponentProps } from 'phosphor-svelte';
  import type { Component } from 'svelte';

  const ICONS: Record<MessageShieldCode, Component<IconComponentProps>> = {
    authenticity_not_guaranteed: KeyIcon,
    mismatched_sender: ShieldWarningIcon,
    sent_in_clear: LockSimpleOpenIcon,
    unknown_device: ShieldWarningIcon,
    unsigned_device: ShieldWarningIcon,
    unverified_identity: ShieldIcon,
    verification_violation: ShieldWarningIcon,
  };

  const KEYS: Record<MessageShieldCode, string> = {
    authenticity_not_guaranteed: 'authenticityNotGuaranteed',
    unknown_device: 'unknownDevice',
    unsigned_device: 'unsignedDevice',
    unverified_identity: 'unverifiedIdentity',
    verification_violation: 'verificationViolation',
    mismatched_sender: 'mismatchedSender',
    sent_in_clear: 'sentInClear',
  };

  interface Props {
    shield: MessageShieldView;
  }

  const { shield }: Props = $props();

  let detailsOpen = $state(false);
</script>

{const Icon = ICONS[shield.code]}

<button
  type="button"
  class={['message-crypto-status', { critical: shield.critical }]}
  onclick={() => {
    detailsOpen = true;
  }}
>
  <Icon weight="fill" />
</button>

<ResponsiveInfoDialog
  bind:open={detailsOpen}
  label={i18n.t(`timeline.shield.title.${KEYS[shield.code]}`)}
  closeLabel={i18n.t('common.close')}
>
  {#snippet header()}
    <Icon />
    <h2>{i18n.t(`timeline.shield.title.${KEYS[shield.code]}`)}</h2>
  {/snippet}

  {#snippet body()}
    <p>{i18n.t(`timeline.shield.body.${KEYS[shield.code]}`)}</p>
  {/snippet}
</ResponsiveInfoDialog>

<style>
  .message-crypto-status {
    align-self: flex-start;
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    line-height: 0;
    margin-left: var(--space-200);
    padding: 0;

    :global(svg) {
      color: var(--sec-main);
      font-size: var(--font-size-body);
    }

    &.critical :global(svg) {
      color: var(--crit-main);
    }

    &:hover :global(svg) {
      color: var(--sec-main-hover);
    }

    &:active :global(svg) {
      color: var(--sec-main-active);
    }

    &.critical:hover :global(svg) {
      color: var(--crit-main-hover);
    }

    &.critical:active :global(svg) {
      color: var(--crit-main-active);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .message-crypto-status:active {
      scale: 0.96;
    }

    :global(html:not([data-reduced-motion='on'])) .message-crypto-status {
      transition: scale var(--motion-fast) var(--ease-smooth-out);
    }
  }
</style>
