<script lang="ts">
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import LockSimpleOpenIcon from 'phosphor-svelte/lib/LockSimpleOpenIcon';

  import type { MessageShieldCode, MessageShieldView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    shield: MessageShieldView;
  }

  let { shield }: Props = $props();

  const KEYS: Record<MessageShieldCode, string> = {
    authenticity_not_guaranteed: 'authenticityNotGuaranteed',
    unknown_device: 'unknownDevice',
    unsigned_device: 'unsignedDevice',
    unverified_identity: 'unverifiedIdentity',
    verification_violation: 'verificationViolation',
    mismatched_sender: 'mismatchedSender',
    sent_in_clear: 'sentInClear',
  };

  let Icon = $derived(shield.code === 'sent_in_clear' ? LockSimpleOpenIcon : ShieldWarningIcon);
</script>

<p class={['shield', { critical: shield.critical }]}>
  <Icon class="shield-icon" aria-hidden="true" />
  <span>{i18n.t(`timeline.shield.${KEYS[shield.code]}`)}</span>
</p>

<style>
  .shield {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    line-height: 1.4;
    margin: var(--space-100) 0 0;
  }

  .critical {
    color: var(--crit-main);
  }

  .shield :global(.shield-icon) {
    flex: none;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
