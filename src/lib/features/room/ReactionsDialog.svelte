<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import type { ReactionGroup } from '@/generated/ReactionGroup';

  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';
  import IdentityRow from '$lib/ui/primitives/IdentityRow.svelte';

  import { initials, senderColor } from './timeline-format';

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

  function name(userId: string): string {
    return members.find((member) => member.user_id === userId)?.display_name ?? userId;
  }

  function avatar(userId: string): string | null {
    return members.find((member) => member.user_id === userId)?.avatar_url ?? null;
  }
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
              initials={initials(name(sender))}
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
    gap: 0.25rem;
  }

  :global(.tab) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
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
