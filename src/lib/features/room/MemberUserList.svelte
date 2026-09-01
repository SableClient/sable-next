<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import MemberIdentityRow from './MemberIdentityRow.svelte';

  interface Props {
    title: string;
    userIds: readonly string[];
    members: readonly MemberView[];
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
    emptyTitle?: string;
    closeLabel?: string;
    onClose?: () => void;
    showHeader?: boolean;
  }

  let {
    title,
    userIds,
    members,
    onMemberProfile,
    emptyTitle = $i18n.t('timeline.noReceipts'),
    closeLabel = $i18n.t('timeline.closeMembers'),
    onClose,
    showHeader = true,
  }: Props = $props();
</script>

<aside class="member-user-list" aria-label={title}>
  {#if showHeader}
    <header>
      <h2 class="title">{title}</h2>
      {#if onClose}
        <IconButton variant="ghost" size="small" label={closeLabel} onclick={onClose}
          ><XIcon /></IconButton
        >
      {/if}
    </header>
  {/if}
  {#if userIds.length === 0}
    <EmptyState title={emptyTitle} />
  {:else}
    <ul>
      {#each userIds as userId (userId)}
        <li>
          <MemberIdentityRow class="member" {userId} {members} onProfile={onMemberProfile} />
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .member-user-list {
    display: flex;
    flex-direction: column;
    max-height: 100%;
    min-height: 0;
    width: 100%;
  }

  header {
    align-items: center;
    background: var(--sable-bg-container);
    border-bottom: var(--border-width) solid var(--sable-surface-var-container);
    display: flex;
    justify-content: space-between;
    min-height: 3.75rem;
    padding: var(--space-200) var(--space-300) var(--space-200) var(--space-400);
  }

  .title {
    font-size: var(--font-size-body);
    margin: 0;
  }

  ul {
    flex: 1;
    list-style: none;
    margin: 0;
    max-height: 16rem;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-100) var(--space-200) var(--space-200);
  }

  :global(.member-user-list .member) {
    min-height: 3rem;
    padding: 0 var(--space-200);
  }
</style>
