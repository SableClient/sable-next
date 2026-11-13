<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    description,
    children,
    variant = 'emote',
  }: {
    label: string;
    description?: string | null;
    children: Snippet;
    variant?: 'emote' | 'reaction';
  } = $props();
</script>

<span class={['emote-card', { reaction: variant === 'reaction' }]}>
  <span class="emote-card-image">{@render children()}</span>
  <span class="emote-card-text">
    <span class="emote-card-name">{label}</span>
    {#if description}<span class="emote-card-description">{description}</span>{/if}
  </span>
</span>

<style>
  .emote-card {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .emote-card-image {
    align-items: center;
    display: flex;
    flex: none;
    height: var(--space-800);
    justify-content: center;
    width: var(--space-800);
  }

  .emote-card-image :global(img),
  .emote-card-image :global(.media-image-content),
  .emote-card-image :global(.media-image) {
    display: block;
    height: 100%;
    object-fit: contain;
    width: 100%;
  }

  .emote-card-image :global(.pixelated) {
    image-rendering: pixelated;
  }

  .emote-card-text {
    display: grid;
    gap: var(--space-050);
    min-width: 0;
  }

  .emote-card-description {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  .emote-card-name {
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-medium);
  }

  .reaction .emote-card-image {
    height: var(--space-900);
    width: var(--space-900);
  }

  .reaction .emote-card-name {
    font: inherit;
  }
</style>
