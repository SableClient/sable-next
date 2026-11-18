<script lang="ts">
  import type { MessageShieldView, SharedByView } from '#src/generated/protocol';

  import MessageShieldNotice from './MessageCryptoStatus.svelte';
  import MessageSharedBy from './MessageSharedBy.svelte';

  interface Props {
    shield: MessageShieldView | null;
    sharedBy: SharedByView | null;
  }

  let { shield, sharedBy }: Props = $props();
</script>

<span class="crypto-indicators">
  {#if shield}
    <MessageShieldNotice {shield} />
  {/if}
  {#if sharedBy}
    <MessageSharedBy {sharedBy} />
  {/if}
</span>

<style>
  .crypto-indicators {
    align-self: flex-start;
    display: flex;
    gap: var(--space-100);
    margin-inline-start: var(--space-200);
  }

  .crypto-indicators > :global(button) {
    margin-inline-start: 0;
  }
</style>
