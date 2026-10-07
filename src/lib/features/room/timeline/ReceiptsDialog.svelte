<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import ResponsiveDialog from '#lib/ui/primitives/ResponsiveDialog.svelte';

  import MemberUserList from '../members/MemberUserList.svelte';
  import ReadReceiptTime from './ReadReceiptTime.svelte';

  interface Props {
    open?: boolean;
    readers: readonly string[];
    timestamps?: Readonly<Record<string, number>>;
    members: readonly MemberView[];
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    open = $bindable(false),
    readers,
    timestamps = {},
    members,
    onMemberProfile,
  }: Props = $props();
</script>

{#snippet content(desktop: boolean)}
  <div class="receipts-dialog" class:sheet={!desktop}>
    <h2>{$i18n.t('common.readReceipts')}</h2>
    <MemberUserList
      title={$i18n.t('common.readReceipts')}
      userIds={readers}
      {members}
      {onMemberProfile}
      showHeader={false}
    >
      {#snippet secondary(userId: string)}
        <ReadReceiptTime timestamp={timestamps[userId]} />
      {/snippet}
    </MemberUserList>
  </div>
{/snippet}

<ResponsiveDialog
  bind:open
  label={$i18n.t('common.readReceipts')}
  closeLabel={$i18n.t('timeline.closeReadReceipts')}
  children={content}
/>

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
