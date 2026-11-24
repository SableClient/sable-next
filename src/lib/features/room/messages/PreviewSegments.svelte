<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';

  import type { PreviewEmote } from '#src/generated/protocol';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  let { segments }: { segments: readonly (string | PreviewEmote)[] } = $props();

  const failedEmotes = new SvelteSet<string>();
</script>

<span class="preview-segments"
  >{#each segments as segment, index (index)}{#if typeof segment === 'string' || failedEmotes.has(segment.source)}{typeof segment ===
      'string'
        ? segment
        : segment.alt}{:else}<MediaImage
        class="preview-emote"
        source={segment.source}
        alt={segment.alt}
        title={segment.alt}
        width={64}
        height={64}
        original
        emoticon
        onfailed={(source) => failedEmotes.add(source)}
      />{/if}{/each}</span
>

<style>
  .preview-segments :global(.preview-emote) {
    display: inline-block;
    height: 1.25em;
    max-width: 6em;
    object-fit: contain;
    vertical-align: middle;
    width: calc(1.25em * var(--media-ratio, 1));
  }
</style>
