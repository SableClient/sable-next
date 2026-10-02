<script lang="ts">
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import LinkPreviewCard from '../LinkPreviewCard.svelte';

  import { parseTiktokLink, tiktokPlayerUrl } from './tiktok';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  let post = $derived(parseTiktokLink(url));
  let playing = $state(false);
  let title = $derived(post?.author ?? 'TikTok');

  $effect(() => {
    void url;
    playing = false;
  });
</script>

{#if post}
  <div class="tiktok-embed">
    <a class="tiktok-header" href={url} target="_blank" rel="noopener noreferrer">
      <span class="tiktok-site">TikTok</span>
      <span class="tiktok-title">{title}</span>
    </a>
    <div class="tiktok-player">
      {#if playing}
        <iframe
          src={tiktokPlayerUrl(post)}
          {title}
          allow="autoplay; fullscreen"
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      {:else}
        <button
          type="button"
          class="tiktok-poster"
          aria-label={$i18n.t('timeline.playVideo', { name: title })}
          onclick={() => (playing = true)}
        >
          <span class="tiktok-play" aria-hidden="true"><PlayIcon /></span>
        </button>
      {/if}
    </div>
  </div>
{:else}
  <LinkPreviewCard {url} {encrypted} {bundled} />
{/if}

<style>
  .tiktok-embed {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    max-width: min(var(--timeline-media-max), 100%);
    overflow: hidden;
    width: 20rem;
  }

  .tiktok-header {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
  }

  .tiktok-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .tiktok-title {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tiktok-header:hover .tiktok-title {
    text-decoration: underline;
  }

  .tiktok-player {
    aspect-ratio: 9 / 16;
    background: var(--surface-var-container);
    position: relative;
    width: 100%;
  }

  .tiktok-player iframe,
  .tiktok-poster {
    border: 0;
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  .tiktok-poster {
    background: none;
    cursor: pointer;
    padding: 0;
  }

  .tiktok-play {
    align-items: center;
    background: var(--surface-container);
    border-radius: 50%;
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    display: flex;
    left: 50%;
    padding: var(--space-200);
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .tiktok-play :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .tiktok-poster:hover .tiktok-play,
  .tiktok-poster:focus-visible .tiktok-play {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }
</style>
