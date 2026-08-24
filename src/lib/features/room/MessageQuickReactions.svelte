<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { shortcodeFor } from '#lib/emoji/emoji.js';
  import { readRecentReactions, rememberReaction } from '#lib/emoji/recents.js';

  interface Props {
    count: number;
    onReact: (emoji: string) => void;
  }

  let { count, onReact }: Props = $props();
  let recents = $derived(readRecentReactions().slice(0, count));

  function react(emoji: string): void {
    rememberReaction(emoji);
    onReact(emoji);
  }
</script>

{#if recents.length > 0}
  <div class="quick-strip" role="group" aria-label={$i18n.t('timeline.addReaction')}>
    {#each recents as emoji (emoji)}
      <button
        type="button"
        class="quick-reaction"
        aria-label={shortcodeFor(emoji) ?? emoji}
        onclick={() => {
          react(emoji);
        }}>{emoji}</button
      >
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
    background: var(--sable-surface-var-container);
    border: 0;
    border-radius: var(--radii-pill);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-t500);
    height: var(--control-height-300);
    justify-content: center;
    line-height: 1;
    min-width: var(--control-height-300);
  }

  .quick-reaction:hover {
    background: var(--sable-surface-var-container-hover);
  }

  .quick-reaction:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .quick-line {
    background: var(--sable-surface-container-line);
    block-size: var(--border-width);
  }
</style>
