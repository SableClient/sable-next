<script lang="ts">
  import InstagramLogoIcon from 'phosphor-svelte/lib/InstagramLogoIcon';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';

  import LinkPreviewCard from '../LinkPreviewCard.svelte';

  import { instagramEmbedUrl, parseInstagramLink } from './instagram';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  let post = $derived(parseInstagramLink(url));
  let playing = $state(false);
  const title = 'Instagram';

  $effect(() => {
    void url;
    playing = false;
  });
</script>

{#if post}
  <div class="instagram-embed">
    <a class="instagram-header" href={url} target="_blank" rel="noopener noreferrer">
      <span class="instagram-site">Instagram</span>
      <span class="instagram-title">{post.kind === 'reel' ? 'Reel' : 'Post'}</span>
    </a>
    <div class="instagram-player" class:reel={post.kind === 'reel'}>
      {#if playing}
        <iframe
          src={instagramEmbedUrl(post)}
          {title}
          allow="fullscreen"
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      {:else}
        <button
          type="button"
          class="instagram-poster"
          aria-label={$i18n.t('timeline.showEmbed', { name: title })}
          onclick={() => (playing = true)}
        >
          <span class="instagram-play" aria-hidden="true"><InstagramLogoIcon /></span>
        </button>
      {/if}
    </div>
  </div>
{:else}
  <LinkPreviewCard {url} {encrypted} {bundled} />
{/if}

<style>
  .instagram-embed {
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

  .instagram-header {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
  }

  .instagram-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .instagram-title {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .instagram-header:hover .instagram-title {
    text-decoration: underline;
  }

  .instagram-player {
    aspect-ratio: 4 / 5;
    background: var(--surface-var-container);
    position: relative;
    width: 100%;
  }

  .instagram-player.reel {
    aspect-ratio: 9 / 16;
  }

  .instagram-player iframe,
  .instagram-poster {
    border: 0;
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  .instagram-poster {
    background: none;
    cursor: pointer;
    padding: 0;
  }

  .instagram-play {
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

  .instagram-play :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .instagram-poster:hover .instagram-play,
  .instagram-poster:focus-visible .instagram-play {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }
</style>
