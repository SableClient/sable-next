<script lang="ts">
  import MusicNotesIcon from 'phosphor-svelte/lib/MusicNotesIcon';

  import type { AudioMetadataView } from '#src/generated/protocol';

  import { blurhashDataUrl } from './blurhash.js';

  interface Props {
    metadata: AudioMetadataView;
    fallbackTitle: string;
  }

  let { metadata, fallbackTitle }: Props = $props();

  const COVER_SIZE = 32;

  let cover = $derived(
    metadata.cover_art ? blurhashDataUrl(metadata.cover_art, COVER_SIZE, COVER_SIZE) : null
  );
  let byline = $derived([metadata.artist, metadata.album].filter(Boolean).join(' · '));
</script>

<div class="audio-track" style:--audio-cover={cover ? `url(${cover})` : undefined}>
  <span class="audio-track-cover" class:empty={!cover} aria-hidden="true">
    {#if !cover}<MusicNotesIcon />{/if}
  </span>
  <span class="audio-track-text">
    <span class="audio-track-title">{metadata.title ?? fallbackTitle}</span>
    {#if byline}<span class="audio-track-byline">{byline}</span>{/if}
  </span>
</div>

<style>
  .audio-track {
    align-items: center;
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    isolation: isolate;
    overflow: hidden;
    padding: var(--space-200);
    position: relative;
  }

  .audio-track::before {
    background: var(--audio-cover, none) center / cover;
    content: '';
    filter: blur(1.5rem) saturate(1.2);
    inset: 0;
    opacity: var(--opacity-p300);
    position: absolute;
    transform: scale(1.4);
    z-index: -1;
  }

  .audio-track-cover {
    align-items: center;
    background: var(--audio-cover, none) center / cover;
    border-radius: var(--radius-inner);
    display: flex;
    flex: none;
    height: var(--avatar-size-large);
    justify-content: center;
    width: var(--avatar-size-large);
  }

  .audio-track-cover.empty {
    background: var(--surface-container);
    color: var(--surface-var-on-container);
  }

  .audio-track-text {
    display: grid;
    min-width: 0;
  }

  .audio-track-title {
    font-weight: var(--font-weight-bold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audio-track-byline {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
