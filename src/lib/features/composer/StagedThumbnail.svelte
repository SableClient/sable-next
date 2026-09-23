<script lang="ts">
  import ImageBrokenIcon from 'phosphor-svelte/lib/ImageBrokenIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatClockDuration } from '#lib/ui/clock-duration.js';

  import { objectSource, type PreviewKind } from './composer-files';

  interface Props {
    file: File;
    kind: PreviewKind;
    spoiler: boolean;
    onOpen: () => void;
  }

  let { file, kind, spoiler, onOpen }: Props = $props();

  let failed = $state(false);
  let duration = $state<number | null>(null);
</script>

<button
  class="thumb"
  class:thumb-spoiler={spoiler}
  type="button"
  aria-label={$i18n.t('composer.previewAttachment', { name: file.name })}
  onclick={onOpen}
>
  {#if failed}
    <span class="thumb-fallback" aria-hidden="true"><ImageBrokenIcon /></span>
  {:else if kind === 'image'}
    <img
      class="thumb-media"
      alt=""
      decoding="async"
      draggable="false"
      {@attach objectSource(file)}
      onerror={() => (failed = true)}
    />
  {:else}
    <video
      class="thumb-media"
      muted
      playsinline
      preload="metadata"
      disablepictureinpicture
      tabindex="-1"
      {@attach objectSource(file, '#t=0.1')}
      onloadedmetadata={(event) => {
        const seconds = event.currentTarget.duration;
        duration = Number.isFinite(seconds) ? Math.round(seconds) : null;
      }}
      onerror={() => (failed = true)}
    ></video>
    <span class="thumb-badge" aria-hidden="true">
      <PlayIcon weight="fill" />
      {#if duration !== null}{formatClockDuration(duration)}{/if}
    </span>
  {/if}
</button>

<style>
  .thumb {
    background: var(--surface-var-container);
    border: 0;
    border-radius: inherit;
    color: var(--surface-var-on-container);
    cursor: zoom-in;
    display: block;
    height: 100%;
    overflow: hidden;
    padding: 0;
    position: relative;
    width: 100%;
  }

  .thumb:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .thumb-media {
    display: block;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    user-select: none;
    width: 100%;
  }

  @media (prefers-reduced-motion: no-preference) {
    .thumb-media {
      transition:
        scale var(--motion-slow) var(--ease-smooth-out),
        filter var(--motion-slow) var(--ease-smooth-out);
    }
  }

  .thumb-spoiler .thumb-media {
    filter: blur(0.75rem);
    scale: 1.2;
  }

  @media (hover: hover) {
    .thumb:hover:not(.thumb-spoiler) .thumb-media {
      scale: 1.04;
    }
  }

  .thumb-fallback {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    position: absolute;
  }

  .thumb-fallback :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .thumb-badge {
    align-items: center;
    background: var(--media-scrim);
    border-radius: var(--radius-pill);
    color: var(--media-on-scrim);
    display: flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    gap: var(--space-050);
    inset-block-start: var(--space-100);
    inset-inline-start: var(--space-100);
    line-height: 1;
    padding: var(--space-050) var(--space-100);
    position: absolute;
  }

  .thumb-badge :global(svg) {
    height: 0.75em;
    width: 0.75em;
  }
</style>
