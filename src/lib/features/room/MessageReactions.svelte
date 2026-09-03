<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import { onDestroy } from 'svelte';

  import type { MemberView } from '#src/generated/MemberView';
  import type { TimelineItemView } from '#src/generated/TimelineItemView';

  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { LongPress } from './long-press.svelte.js';
  import ReactionPicker from './ReactionPicker.svelte';
  import { reactionSummary } from './reaction-summary.js';

  interface Props {
    reactions: TimelineItemView['reactions'];
    eventId: string | null;
    currentUserId: string | null;
    members: readonly MemberView[];
    roomId: string;
    actionable: boolean;
    onReact?: (key: string) => void;
    onToggleReaction?: (eventId: string, key: string) => void;
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
</script>

<BitsTooltip.Provider delayDuration={400} skipDelayDuration={100}>
  <div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
    {#each reactions as reaction, index (reaction.key)}
      {@const mine = currentUserId !== null && reaction.senders.includes(currentUserId)}
      {#snippet reactionTrigger({ props }: { props: Record<string, unknown> })}
        <button
          {...props}
          class="reaction sable-choice"
          type="button"
          aria-pressed={mine}
          aria-label={$i18n.t('timeline.toggleReaction', {
            key: reaction.key,
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
          {#if reaction.key.startsWith('mxc://')}
            <MediaImage
              class="reaction-image"
              source={reaction.key}
              alt={reaction.key}
              width={64}
              height={64}
              original
            />
          {:else}
            <em>{reaction.key}</em>
          {/if}
          {reaction.senders.length}
        </button>
      {/snippet}
      <BitsTooltip.Root>
        <BitsTooltip.Trigger child={reactionTrigger} />
        <BitsTooltip.Portal>
          <BitsTooltip.Content class="reaction-tooltip" side="top" align="center" sideOffset={8}>
            {reactionSummary(reaction.senders, reaction.key, members, $i18n.t)}
          </BitsTooltip.Content>
        </BitsTooltip.Portal>
      </BitsTooltip.Root>
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
</BitsTooltip.Provider>

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    margin-top: var(--space-150);
  }

  .reactions :global(.add-reaction) {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    min-height: 1.5rem;
    padding: var(--space-050) var(--space-200);
  }

  .reaction {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    min-height: 1.5rem;
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

  .reaction em {
    font-size: var(--font-size-body);
    font-style: normal;
    line-height: 1;
  }

  .reaction:disabled {
    cursor: default;
  }

  .reaction:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
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
      background: var(--sable-surface-var-container-hover);
    }
  }
</style>
