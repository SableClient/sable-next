<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';

  import { i18n } from '$lib/i18n';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';
  import EmptyState from '$lib/ui/primitives/EmptyState.svelte';
  import IdentityRow from '$lib/ui/primitives/IdentityRow.svelte';

  import { initials, senderColor } from './timeline-format';

  interface Props {
    open?: boolean;
    readers: readonly string[];
    members: readonly MemberView[];
  }

  let { open = $bindable(false), readers, members }: Props = $props();

  function name(userId: string): string {
    return members.find((member) => member.user_id === userId)?.display_name ?? userId;
  }

  function avatar(userId: string): string | null {
    return members.find((member) => member.user_id === userId)?.avatar_url ?? null;
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.readReceipts')}>
  <div class="receipts-dialog">
    <h2>{$i18n.t('timeline.readReceipts')}</h2>
    {#if readers.length === 0}
      <EmptyState title={$i18n.t('timeline.noReceipts')} />
    {:else}
      <ul>
        {#each readers as reader (reader)}
          <li>
            <IdentityRow
              displayName={name(reader)}
              avatarUrl={avatar(reader)}
              color={senderColor(reader)}
              initials={initials(name(reader))}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogFrame>

<style>
  .receipts-dialog {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-4);
    width: min(22rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  ul {
    display: grid;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-1);
  }
</style>
