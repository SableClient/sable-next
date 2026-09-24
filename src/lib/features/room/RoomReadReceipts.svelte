<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';

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

<ResponsivePopover
  bind:open
  {anchor}
  class="read-receipts-popover"
  align="end"
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
</ResponsivePopover>

<style>
  .room-read-receipts {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }

  :global(.read-receipts-popover) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: flex;
    max-height: min(28rem, calc(100dvh - 2rem));
    overflow: hidden;
  }

  :global(.read-receipts-popover .member-user-list) {
    max-height: 100%;
    min-height: 0;
  }
</style>
