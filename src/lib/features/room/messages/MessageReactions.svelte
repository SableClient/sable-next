<script lang="ts">
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  import type { ImagePackView, MemberView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { shortcodeFor } from '#lib/emoji/emoji.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { LongPress, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import ReactionSheet from './ReactionSheet.svelte';
  import { reactionSummary } from './reaction-summary.js';
  import {
    hasRoomMediaPreviews,
    useRoomMediaPreviews,
  } from '../media/room-media-previews.svelte.js';
  import {
    isCustomReaction,
    loadReactionEmotePacks,
    loadReactionShortcodes,
    reactionEmoteLabel,
    reactionShortcode,
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
  let sentShortcodes = $state.raw<ReadonlyMap<string, string>>(new Map());
  let customKeys = $derived(
    reactions
      .map((reaction) => reaction.key)
      .filter(isCustomReaction)
      .sort()
      .join('\n')
  );
  let addReactionButton = $state<HTMLElement | null>(null);
  let addReactionOpen = $state(false);
  const failedImages = new SvelteSet<string>();
  const press = new LongPress({
    stopPropagation: true,
    onPress: () => onViewReactions?.(pressIndex),
  });

  function openDetails(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (!touchContextMenu(event)) onViewReactions?.(index);
  }

  onDestroy(() => {
    press.cancel();
  });

  $effect(() => {
    const keys = customKeys;
    const target = eventId;
    if (target === null || keys === '') return;
    let current = true;
    void loadReactionShortcodes(roomId, target, keys.split('\n'), () =>
      core.commands.reactionShortcodes(roomId, target)
    )
      .then((shortcodes) => {
        if (current) sentShortcodes = shortcodes;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
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
  const roomMedia = hasRoomMediaPreviews() ? useRoomMediaPreviews() : null;
  let mediaHidden = $derived(roomMedia?.hidden ?? false);
</script>

<div class="reactions" aria-label={$i18n.t('timeline.reactions')}>
  {#each reactions as reaction, index (reaction.key)}
    {@const mine = currentUserId !== null && reaction.senders.includes(currentUserId)}
    {@const label = reactionEmoteLabel(
      reaction.key,
      imagePacks,
      $i18n.t('timeline.customEmote'),
      sentShortcodes
    )}
    {@const shortcode = reactionShortcode(reaction.key, imagePacks, sentShortcodes)}
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
        oncontextmenu={(event) => openDetails(event, index)}
        onpointerdown={(event) => {
          pressIndex = index;
          press.start(event);
        }}
        onpointermove={press.move}
        onpointerup={press.end}
        onpointercancel={press.end}
      >
        <span class={['reaction-key', failedImages.has(reaction.key) && 'failed']}>
          {#if isCustomReaction(reaction.key) && mediaHidden}
            <span class="reaction-shortcode">{shortcode ?? label}</span>
          {:else if isCustomReaction(reaction.key)}
            <MediaImage
              class="reaction-image"
              source={reaction.key}
              alt={label}
              width={64}
              height={64}
              original
              onloaded={() => failedImages.delete(reaction.key)}
              onfailed={() => failedImages.add(reaction.key)}
            />
            {#if failedImages.has(reaction.key)}
              {#if shortcode === null}
                <WarningIcon class="reaction-image-failed" aria-hidden="true" />
              {:else}
                <span class="reaction-shortcode" aria-hidden="true">{shortcode}</span>
              {/if}
            {/if}
          {:else}
            <em>{reaction.key}</em>
          {/if}
        </span>
        <span class="reaction-count">{reaction.senders.length}</span>
      </button>
    {/snippet}
    {@const emojiShortcode = isCustomReaction(reaction.key) ? null : shortcodeFor(reaction.key)}
    {@const summary = reactionSummary(
      reaction.senders,
      emojiShortcode ? `:${emojiShortcode}:` : label,
      members,
      $i18n.t
    )}
    {#snippet emoteCard()}
      <span class="emote-card">
        {#if isCustomReaction(reaction.key)}
          <MediaImage
            class="emote-card-image"
            source={reaction.key}
            alt=""
            width={64}
            height={64}
            original
          />
        {:else}
          <span class="emote-card-emoji" aria-hidden="true">{reaction.key}</span>
        {/if}
        <span>{summary}</span>
      </span>
    {/snippet}
    <Tooltip
      label={summary}
      side="top"
      trigger={reactionTrigger}
      content={(
        isCustomReaction(reaction.key)
          ? !mediaHidden && !failedImages.has(reaction.key)
          : emojiShortcode !== null
      )
        ? emoteCard
        : undefined}
    />
  {/each}
  {#if actionable && onReact}
    {@const react = onReact}
    <button
      type="button"
      class="add-reaction"
      aria-label={$i18n.t('timeline.addReaction')}
      bind:this={addReactionButton}
      onclick={() => (addReactionOpen = true)}
    >
      <PlusIcon />
    </button>
    {#if addReactionOpen}
      <ReactionSheet
        bind:open={addReactionOpen}
        {roomId}
        anchor={addReactionButton}
        onPick={react}
      />
    {/if}
  {/if}
</div>

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    margin-top: var(--space-150);
  }

  .add-reaction {
    --target: 1.5rem;

    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radii-400);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    min-height: var(--target);
    padding: var(--space-050) var(--space-200);
    position: relative;
  }

  .add-reaction::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  .reaction {
    --target: 1.5rem;

    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radii-400);
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
    min-height: var(--target);
    min-width: 0;
    padding: var(--space-050) var(--space-200) var(--space-050) var(--space-150);
    position: relative;
  }

  .reaction::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  .reaction :global(.reaction-image) {
    display: block;
    height: 1.125rem;
    max-width: 9.375rem;
    object-fit: contain;
    width: calc(1.125rem * var(--media-ratio));
  }

  .emote-card {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .emote-card :global(.emote-card-image) {
    flex: none;
    height: var(--space-900);
    object-fit: contain;
    width: var(--space-900);
  }

  .emote-card-emoji {
    flex: none;
    font-size: var(--font-size-emoji-display);
    line-height: 1;
  }

  .reaction-key {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .reaction-key.failed :global(.reaction-image) {
    display: none;
  }

  .reaction-key :global(.reaction-image-failed) {
    color: var(--surface-var-on-container);
    display: block;
    height: 1.125rem;
    opacity: 0.6;
    width: 1.125rem;
  }

  .reaction-shortcode {
    display: block;
    font-size: var(--font-size-label);
    line-height: 1.125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reaction-key em {
    display: block;
    font-size: var(--font-size-body);
    font-style: normal;
    line-height: 1;
  }

  .reaction-count {
    align-self: center;
    font-size: var(--font-size-label);
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

  @media (any-hover: hover) and (any-pointer: fine) {
    .reaction:hover:not(:disabled, [aria-pressed='true']) {
      background: var(--surface-var-container-hover);
    }
  }
</style>
