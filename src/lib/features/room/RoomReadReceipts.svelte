<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import type { MemberView } from '@/generated/MemberView';

  import { i18n } from '$lib/i18n';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';

  import MembersDrawer from './MembersDrawer.svelte';

  interface Props {
    readers: readonly string[];
    members: readonly MemberView[];
    loading: boolean;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let { readers, members, loading, onMemberProfile }: Props = $props();
  let open = $state(false);

  function readerName(userId: string): string {
    const match = /^@?([^:]+)(?::.*)?$/.exec(userId);
    return match?.[1] ?? userId;
  }
</script>

<div class="room-read-receipts">
  {#if readers.length > 0}
    <button
      type="button"
      aria-label={$i18n.t('timeline.readReceipts')}
      title={readers.join(', ')}
      onclick={() => {
        open = true;
      }}
    >
      <ChecksIcon aria-hidden="true" weight="bold" />
      {#if readers.length === 1}
        {$i18n.t('timeline.followingConversationOne', { name: readerName(readers[0] ?? '') })}
      {:else}
        {$i18n.t('timeline.followingConversationOther', {
          names: readers.map(readerName).join(', '),
        })}
      {/if}
    </button>
  {/if}
</div>

<DialogFrame bind:open variant="sheet" label={$i18n.t('timeline.readReceipts')}>
  <MembersDrawer
    {members}
    {loading}
    compact
    searchable={false}
    title={$i18n.t('timeline.seenBy')}
    onClose={() => {
      open = false;
    }}
    {onMemberProfile}
  />
</DialogFrame>

<style>
  .room-read-receipts {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    justify-content: flex-end;
    min-height: 1.75rem;
    padding: 0 1rem;
  }

  button {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: 0.375rem;
    min-height: 1.75rem;
    padding: 0;
  }

  button:hover,
  button:focus-visible {
    color: var(--sable-primary-main);
  }

  button :global(svg) {
    opacity: 0.6;
  }
</style>
