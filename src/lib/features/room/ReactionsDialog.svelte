<script lang="ts">
  import type { ImagePackView, MemberView, ReactionGroup } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import MemberIdentityRow from './MemberIdentityRow.svelte';
  import {
    isCustomReaction,
    loadReactionEmotePacks,
    reactionEmoteLabel,
  } from './reaction-emote-label.js';

  interface Props {
    open?: boolean;
    reactions: readonly ReactionGroup[];
    roomId: string;
    members: readonly MemberView[];
    active?: number;
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    open = $bindable(false),
    reactions,
    roomId,
    members,
    active = $bindable(0),
    onMemberProfile,
  }: Props = $props();
  let group = $derived<ReactionGroup | undefined>(
    reactions[Math.min(active, reactions.length - 1)]
  );
  const core = useCoreClient();
  let imagePacks = $state.raw<ImagePackView[]>([]);

  $effect(() => {
    let current = true;
    void loadReactionEmotePacks(roomId, core.commands.imagePacks)
      .then((packs) => {
        if (current) imagePacks = packs;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.viewReactions')}>
  <div class="reactions-dialog">
    <h2>{$i18n.t('timeline.viewReactions')}</h2>
    <div class="tabs" role="tablist" aria-label={$i18n.t('timeline.viewReactions')}>
      {#each reactions as reaction, index (reaction.key)}
        {@const label = reactionEmoteLabel(
          reaction.key,
          imagePacks,
          $i18n.t('timeline.customEmote')
        )}
        <Button
          size="small"
          variant="ghost"
          class="tab choice"
          role="tab"
          aria-selected={reaction.key === group?.key}
          onclick={() => {
            active = index;
          }}
        >
          {#if isCustomReaction(reaction.key)}
            <MediaImage
              class="reaction-image"
              source={reaction.key}
              alt={label}
              width={64}
              height={64}
              original
            />
          {:else}
            <em>{reaction.key}</em>
          {/if}
          {reaction.senders.length}
        </Button>
      {/each}
    </div>
    {#if group}
      <ul>
        {#each group.senders as sender (sender)}
          <li>
            <MemberIdentityRow userId={sender} {members} onProfile={onMemberProfile} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogFrame>

<style>
  .reactions-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :global(.tab) {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-050) var(--space-200);
  }

  :global(.tab em) {
    font-style: normal;
  }

  :global(.tab .reaction-image) {
    height: 1.125rem;
    object-fit: contain;
    width: auto;
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
</style>
