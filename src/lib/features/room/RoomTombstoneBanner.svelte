<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    isSpace: boolean;
    body: string | null;
    resolved: boolean;
    successorId: string | null;
    joined: boolean;
    joining: boolean;
    failed: boolean;
    onOpen: () => void;
    onJoin: () => void;
  }

  let { isSpace, body, resolved, successorId, joined, joining, failed, onOpen, onJoin }: Props =
    $props();
</script>

<Alert
  variant="warning"
  role="region"
  aria-label={$i18n.t('room.tombstoneBannerLabel')}
  class="tombstone-banner"
>
  <p class="tombstone-body">
    {body ?? (isSpace ? $i18n.t('room.upgradeReplacedSpace') : $i18n.t('room.upgradeReplacedRoom'))}
  </p>
  <div class="tombstone-action">
    {#if resolved && successorId === null}
      <p class="tombstone-unresolvable">{$i18n.t('room.tombstoneUnresolvable')}</p>
    {:else if successorId !== null && joined}
      <Button onclick={onOpen}>
        {isSpace ? $i18n.t('room.upgradeOpenSpace') : $i18n.t('room.upgradeOpenRoom')}
      </Button>
    {:else if successorId !== null}
      <Button loading={joining} onclick={onJoin}>
        {isSpace ? $i18n.t('room.tombstoneJoinSpace') : $i18n.t('room.tombstoneJoinRoom')}
      </Button>
    {/if}
  </div>
  {#if failed}
    <p class="tombstone-failed" role="alert">{$i18n.t('room.tombstoneJoinFailed')}</p>
  {/if}
</Alert>

<style>
  :global(.tombstone-banner) {
    align-items: flex-start;
    display: grid;
    gap: var(--space-2);
    margin: var(--space-2);
  }

  .tombstone-body {
    margin: 0;
  }

  .tombstone-unresolvable,
  .tombstone-failed {
    margin: 0;
  }

  @media (width >= 48rem) {
    :global(.tombstone-banner) {
      align-items: center;
      grid-template-columns: 1fr auto;
    }

    .tombstone-failed {
      grid-column: 1 / -1;
    }
  }
</style>
