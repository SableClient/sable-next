<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';

  import { i18n } from '#lib/i18n.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import IdentityRow from '#lib/ui/primitives/IdentityRow.svelte';

  import { senderColor } from './timeline-format';
  import { memberAvatar, memberName } from './members.js';

  interface Props {
    open?: boolean;
    readers: readonly string[];
    members: readonly MemberView[];
  }

  let { open = $bindable(false), readers, members }: Props = $props();

  const name = (userId: string): string => memberName(members, userId);
  const avatar = (userId: string): string | null => memberAvatar(members, userId);
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
    gap: var(--space-300);
    width: min(22rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }
</style>
