<script lang="ts">
  import { Popover } from 'bits-ui';
  import type { MemberView } from '#src/generated/MemberView';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';

  import MemberUserList from './MemberUserList.svelte';
  import ReadReceiptStack from './ReadReceiptStack.svelte';

  interface Props {
    readers: readonly string[];
    members: readonly MemberView[];
    visible?: boolean;
    open?: boolean;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    readers,
    members,
    visible = true,
    open = $bindable(false),
    onMemberProfile,
  }: Props = $props();
  let anchor = $state<HTMLButtonElement | null>(null);
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);

  $effect(() => {
    // Losing the readers unmounts the anchor, which would drop a desktop
    // popover through to the bottom sheet branch.
    if (!visible || readers.length === 0) open = false;
  });
</script>

<div class="room-read-receipts">
  {#if visible}
    <ReadReceiptStack
      {readers}
      {members}
      expanded={open}
      onOpen={(element) => {
        anchor = element;
        open = true;
      }}
    />
  {/if}
</div>

{#if desktop && anchor}
  <Popover.Root bind:open>
    <Popover.Portal>
      <Popover.Content class="read-receipts-popover" customAnchor={anchor} side="top" align="end">
        <MemberUserList
          title={$i18n.t('timeline.seenBy')}
          userIds={readers}
          {members}
          {onMemberProfile}
          closeLabel={$i18n.t('timeline.closeReadReceipts')}
          onClose={() => {
            open = false;
          }}
        />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.readReceipts')}
    closeLabel={$i18n.t('timeline.closeReadReceipts')}
  >
    <MemberUserList
      title={$i18n.t('timeline.seenBy')}
      userIds={readers}
      {members}
      {onMemberProfile}
      closeLabel={$i18n.t('timeline.closeReadReceipts')}
      onClose={() => {
        open = false;
      }}
    />
  </BottomSheet>
{/if}

<style>
  .room-read-receipts {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }

  :global(.read-receipts-popover) {
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    display: flex;
    max-height: min(28rem, calc(100dvh - 2rem));
    overflow: hidden;
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }

  :global(.read-receipts-popover .member-user-list) {
    max-height: 100%;
    min-height: 0;
  }
</style>
