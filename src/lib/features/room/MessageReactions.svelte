<script lang="ts">
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import { onDestroy } from 'svelte';

  import type { ImagePackView, MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { LongPress } from './long-press.svelte.js';
  import ReactionPicker from './ReactionPicker.svelte';
  import { reactionSummary } from './reaction-summary.js';
  import {
    isCustomReaction,
    loadReactionEmotePacks,
    reactionEmoteLabel,
  } from './reaction-emote-label.js';

  interface Props {
    reactions: TimelineItemView['reactions'];
    eventId: string | null;
    currentUserId: string | null;
    members: readonly MemberView[];
    roomId: string;
    actionable: boolean;
    onReact?: (
      key: string,
      sourcePack?: import('#src/generated/protocol').ImageSourcePackView | null
    ) => void;
    onToggleReaction?: (
      eventId: string,
      key: string,
      sourcePack?: import('#src/generated/protocol').ImageSourcePackView | null
    ) => void;
    onViewReactions?: (index: number) => void;
  }

  let {
    reactions,
    eventId,
    currentUserId,
    members,
    roomId,
    actionable,
    onReact,
    onToggleReaction,
    onViewReactions,
  }: Props = $props();

  let pressIndex = 0;
  const core = useCoreClient();
  let imagePacks = $state.raw<ImagePackView[]>([]);
  const press = new LongPress({
    stopPropagation: true,
    onPress: () => onViewReactions?.(pressIndex),
  });

  function openDetails(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    onViewReactions?.(index);
  }

  onDestroy(() => {
    press.cancel();
  });

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

<div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
  {#each reactions as reaction, index (reaction.key)}
    {@const mine = currentUserId !== null && reaction.senders.includes(currentUserId)}
    {@const label = reactionEmoteLabel(reaction.key, imagePacks, $i18n.t('timeline.customEmote'))}
    {#snippet reactionTrigger({ props }: { props: Record<string, unknown> })}
      <button
        {...props}
        class="reaction choice"
        type="button"
        aria-pressed={mine}
        aria-label={$i18n.t('timeline.toggleReaction', {
          key: label,
          count: reaction.senders.length,
        })}
        disabled={eventId === null}
        onclick={() => {
          if (press.fired) {
            press.fired = false;
            return;
          }
          if (eventId) onToggleReaction?.(eventId, reaction.key);
        }}
        oncontextmenu={(event) => {
          openDetails(event, index);
        }}
        onpointerdown={(event) => {
          pressIndex = index;
          press.start(event);
        }}
        onpointermove={press.move}
        onpointerup={press.end}
        onpointercancel={press.end}
      >
        <span class="reaction-key">
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
        </span>
        <span class="reaction-count">{reaction.senders.length}</span>
      </button>
    {/snippet}
    <Tooltip
      label={reactionSummary(reaction.senders, label, members, $i18n.t)}
      side="top"
      trigger={reactionTrigger}
    />
  {/each}
  {#if actionable && onReact}
    {@const react = onReact}
    <ReactionPicker
      label={$i18n.t('timeline.addReaction')}
      triggerClass="add-reaction"
      {roomId}
      onPick={react}
    >
      <PlusIcon />
    </ReactionPicker>
  {/if}
</div>

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    margin-top: var(--space-150);
  }

  .reactions :global(.add-reaction) {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    min-height: 1.5rem;
    padding: var(--space-050) var(--space-200);
  }

  .reaction {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: grid;
    font: inherit;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    grid-template-columns: minmax(0, 1fr) auto;
    max-width: 100%;
    min-height: 1.5rem;
    min-width: 0;
    padding: var(--space-050) var(--space-200) var(--space-050) var(--space-150);
    position: relative;
  }

  .reaction::after {
    border-radius: inherit;
    content: '';
    inset: -0.375rem -2px;
    position: absolute;
  }

  .reaction :global(.reaction-image) {
    display: block;
    height: 1.125rem;
    object-fit: contain;
    width: auto;
  }

  .reaction-key {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .reaction-key em {
    font-size: var(--font-size-body);
    font-style: normal;
    line-height: 1;
  }

  .reaction-count {
    align-self: center;
    white-space: nowrap;
  }

  .reaction:disabled {
    cursor: default;
  }

  .reaction:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (prefers-reduced-motion: no-preference) {
    .reaction {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        border-color var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .reaction:hover:not(:disabled, [aria-pressed='true']) {
      background: var(--surface-var-container-hover);
    }
  }
</style>
