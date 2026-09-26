<script lang="ts">
  import type { ImagePackView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { shortcodeFor } from '#lib/emoji/emoji.js';
  import { readRecentReactions, rememberReaction } from '#lib/emoji/recents.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import {
    isCustomReaction,
    loadReactionEmotePacks,
    reactionEmoteLabel,
  } from './reaction-emote-label.js';

  interface Props {
    count: number;
    loadImagePacks?: (roomId: string) => Promise<ImagePackView[]>;
    onReact: (emoji: string) => void;
    roomId?: string;
    roomy?: boolean;
  }

  let { count, loadImagePacks, onReact, roomId, roomy = false }: Props = $props();
  let imagePacks = $state.raw<ImagePackView[]>([]);
  let recents = $derived(readRecentReactions().slice(0, count));

  $effect(() => {
    if (roomId === undefined || loadImagePacks === undefined) {
      imagePacks = [];
      return;
    }

    let current = true;
    void loadReactionEmotePacks(roomId, loadImagePacks)
      .then((packs) => {
        if (current) imagePacks = packs;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });

  function react(emoji: string): void {
    rememberReaction(emoji);
    onReact(emoji);
  }
</script>

{#if recents.length > 0}
  <div class:roomy class="quick-strip" role="group" aria-label={$i18n.t('timeline.addReaction')}>
    {#each recents as emoji (emoji)}
      {@const label = reactionEmoteLabel(emoji, imagePacks, $i18n.t('timeline.customEmote'))}
      <button
        type="button"
        class="quick-reaction"
        aria-label={isCustomReaction(emoji) ? label : (shortcodeFor(emoji) ?? emoji)}
        onclick={() => {
          react(emoji);
        }}
      >
        {#if isCustomReaction(emoji)}
          <MediaImage
            class="quick-reaction-image"
            source={emoji}
            alt={label}
            width={64}
            height={64}
            original
          />
        {:else}
          {emoji}
        {/if}
      </button>
    {/each}
  </div>
  <div class="quick-line"></div>
{/if}

<style>
  .quick-strip {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    justify-content: center;
    padding: var(--space-200);
  }

  .quick-reaction {
    align-items: center;
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radii-pill);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-body);
    height: var(--control-height-300);
    justify-content: center;
    line-height: 1;
    min-width: var(--control-height-300);
    user-select: none;
  }

  .quick-reaction:hover {
    background: var(--surface-var-container-hover);
  }

  .quick-reaction :global(.quick-reaction-image) {
    display: block;
    height: 1.125rem;
    max-width: 9.375rem;
    object-fit: contain;
    width: calc(1.125rem * var(--media-ratio));
  }

  .quick-reaction:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .quick-strip.roomy .quick-reaction {
    height: var(--control-height-400);
    min-width: var(--control-height-400);
  }

  .quick-strip.roomy .quick-reaction :global(.quick-reaction-image) {
    height: 1.5rem;
    width: calc(1.5rem * var(--media-ratio));
  }

  .quick-line {
    background: var(--surface-container-line);
    block-size: var(--border-width);
  }
</style>
