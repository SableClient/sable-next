<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';

  import { i18n } from '#lib/i18n.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import MemberUserList from './MemberUserList.svelte';

  interface Props {
    open?: boolean;
    readers: readonly string[];
    members: readonly MemberView[];
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { open = $bindable(false), readers, members, onMemberProfile }: Props = $props();
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.readReceipts')}>
  <div class="receipts-dialog">
    <h2>{$i18n.t('timeline.readReceipts')}</h2>
    <MemberUserList
      title={$i18n.t('timeline.readReceipts')}
      userIds={readers}
      {members}
      {onMemberProfile}
      showHeader={false}
    />
  </div>
</DialogFrame>

<style>
  .receipts-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(22rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }
</style>
