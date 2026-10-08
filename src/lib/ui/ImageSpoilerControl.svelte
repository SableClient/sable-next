<script lang="ts">
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import { i18n } from '#lib/i18n.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    hidden: boolean;
    reason?: string | null;
    name?: string;
    ontoggle: () => void;
  }

  let { hidden, reason = null, name = '', ontoggle }: Props = $props();
  const reasonId = $props.id();
  let label = $derived(
    name
      ? $i18n.t(hidden ? 'timeline.revealImage' : 'timeline.hideImage', { name })
      : $i18n.t(hidden ? 'timeline.revealImageUnnamed' : 'timeline.hideImageUnnamed')
  );

  function stopPress(event: PointerEvent): void {
    event.stopPropagation();
  }
</script>

<Tooltip label={hidden && reason ? `${reason} — ${label}` : label} multiline={hidden && !!reason}>
  {#snippet trigger({ props })}
    <button
      {...props}
      type="button"
      class="media-image-spoiler"
      class:hidden
      aria-label={label}
      aria-describedby={hidden ? reasonId : undefined}
      onclick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        ontoggle();
      }}
      onpointerdown={stopPress}
      onpointermove={stopPress}
      onpointerup={stopPress}
    >
      <span class="media-image-spoiler-chip">
        <EyeSlashIcon aria-hidden="true" />
        {#if hidden}
          <span class="media-image-spoiler-copy">
            <span id={reasonId}>{reason || $i18n.t('composer.spoiler')}</span>
            <span class="media-image-spoiler-hint">{$i18n.t('timeline.revealImageUnnamed')}</span>
          </span>
        {/if}
      </span>
    </button>
  {/snippet}
</Tooltip>

<style>
  .media-image-spoiler {
    align-items: center;
    background: none;
    border: 0;
    color: var(--media-on-scrim);
    cursor: pointer;
    display: flex;
    font: inherit;
    inset-block-start: 0;
    inset-inline-end: 0;
    justify-content: center;
    min-height: var(--target-hit);
    min-width: var(--target-hit);
    padding: var(--space-100);
    position: absolute;
  }

  .media-image-spoiler.hidden {
    inset: 0;
  }

  .media-image-spoiler-chip {
    align-items: center;
    background: var(--media-scrim);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-float);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-100);
  }

  .hidden .media-image-spoiler-chip {
    max-width: calc(100% - var(--space-200));
    padding: var(--space-200) var(--space-300);
    text-align: start;
  }

  .media-image-spoiler-chip :global(svg) {
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .media-image-spoiler-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-050);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .media-image-spoiler-copy > span:first-child {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .media-image-spoiler-hint {
    font-size: var(--font-size-x-small);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .media-image-spoiler:not(.hidden) {
      opacity: 0;
    }

    :global(.spoilerable-media:hover) .media-image-spoiler,
    :global(.spoilerable-media:focus-within) .media-image-spoiler {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .media-image-spoiler {
      transition: opacity var(--duration-fast) ease-in-out;
    }
  }

  .media-image-spoiler:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }
</style>
