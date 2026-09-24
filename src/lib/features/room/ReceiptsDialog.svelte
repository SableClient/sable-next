<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import MemberUserList from './MemberUserList.svelte';

  interface Props {
    open?: boolean;
    readers: readonly string[];
    members: readonly MemberView[];
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { open = $bindable(false), readers, members, onMemberProfile }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
</script>

{#snippet content()}
  <div class="receipts-dialog" class:sheet={!desktop}>
    <h2>{$i18n.t('timeline.readReceipts')}</h2>
    <MemberUserList
      title={$i18n.t('timeline.readReceipts')}
      userIds={readers}
      {members}
      {onMemberProfile}
      showHeader={false}
    />
  </div>
{/snippet}

{#if desktop}
  <DialogFrame bind:open variant="verification" label={$i18n.t('timeline.readReceipts')}>
    {@render content()}
  </DialogFrame>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.readReceipts')}
    closeLabel={$i18n.t('timeline.closeReadReceipts')}
  >
    {@render content()}
  </BottomSheet>
{/if}

<style>
  .receipts-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(22rem, calc(100vw - 2rem));
  }

  .receipts-dialog.sheet {
    padding: 0 var(--space-400);
    width: auto;
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }
</style>
