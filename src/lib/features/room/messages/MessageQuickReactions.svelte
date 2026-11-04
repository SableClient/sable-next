<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { RoomPacks } from '#lib/emoji/room-packs.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { shortcodeFor } from '#lib/emoji/emoji.js';
  import { RecentReactions } from '#lib/emoji/recents.svelte.js';
  import { quickReactions } from '#lib/model/model.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { isCustomReaction, reactionEmoteLabel } from './reaction-emote-label.js';

  interface Props {
    count: number;
    onReact: (emoji: string) => void;
    roomId?: string;
    roomy?: boolean;
  }

  let { count, onReact, roomId, roomy = false }: Props = $props();
  const core = useCoreClient();
  const history = new RecentReactions(core);
  const packs = new RoomPacks(core, () => roomId);
  let recents = $derived(quickReactions(history.current, count));
</script>

{#if recents.length > 0}
  <div class={['quick-strip', { roomy }]} role="group" aria-label={i18n.t('timeline.addReaction')}>
    {#each recents as emoji (emoji)}
      {@const label = reactionEmoteLabel(emoji, packs.current, i18n.t('timeline.customEmote'))}
      <button
        type="button"
        class="quick-reaction"
        aria-label={isCustomReaction(emoji) ? label : (shortcodeFor(emoji) ?? emoji)}
        onclick={() => {
          onReact(emoji);
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
            emoticon
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
    min-width: 0;
    padding: var(--space-200);
  }

  .quick-reaction {
    align-items: center;
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radii-pill);
    cursor: pointer;
    display: inline-block;
    font-size: var(--font-size-subheading);
    height: var(--control-height-300);
    justify-content: center;
    line-height: 1;
    max-width: 100%;
    min-width: var(--control-height-300);
    overflow: hidden;
    text-box: trim-both cap alphabetic;
    text-overflow: ellipsis;
    user-select: none;
    white-space: nowrap;
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
    margin: var(--space-100) 0;
  }
</style>
