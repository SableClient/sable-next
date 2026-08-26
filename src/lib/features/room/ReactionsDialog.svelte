<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import type { ReactionGroup } from '#src/generated/ReactionGroup';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IdentityRow from '#lib/ui/primitives/IdentityRow.svelte';

  import { senderColor } from './timeline-format';
  import { memberAvatar, memberName } from './members.js';

  interface Props {
    open?: boolean;
    reactions: readonly ReactionGroup[];
    members: readonly MemberView[];
    active?: number;
  }

  let { open = $bindable(false), reactions, members, active = $bindable(0) }: Props = $props();
  let group = $derived<ReactionGroup | undefined>(
    reactions[Math.min(active, reactions.length - 1)]
  );

  const name = (userId: string): string => memberName(members, userId);
  const avatar = (userId: string): string | null => memberAvatar(members, userId);
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.viewReactions')}>
  <div class="reactions-dialog">
    <h2>{$i18n.t('timeline.viewReactions')}</h2>
    <div class="tabs" role="tablist" aria-label={$i18n.t('timeline.viewReactions')}>
      {#each reactions as reaction, index (reaction.key)}
        <Button
          size="small"
          variant="ghost"
          class={['tab', { active: reaction.key === group?.key }]}
          role="tab"
          aria-selected={reaction.key === group?.key}
          onclick={() => {
            active = index;
          }}
        >
          <em>{reaction.key}</em>
          {reaction.senders.length}
        </Button>
      {/each}
    </div>
    {#if group}
      <ul>
        {#each group.senders as sender (sender)}
          <li>
            <IdentityRow
              displayName={name(sender)}
              avatarUrl={avatar(sender)}
              color={senderColor(sender)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogFrame>

<style>
  .reactions-dialog {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-4);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :global(.tab) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-hairline) var(--space-200);
  }

  :global(.tab.active) {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  :global(.tab em) {
    font-style: normal;
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
