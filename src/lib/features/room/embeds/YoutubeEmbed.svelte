<script lang="ts">
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import { i18n } from '#lib/i18n.js';

  import {
    loadYoutubeDetails,
    parseYoutubeLink,
    youtubePlayerUrl,
    youtubeThumbnailUrl,
    type YoutubeDetails,
  } from './youtube';

  let { url }: { url: string } = $props();
  let video = $derived(parseYoutubeLink(url));
  let details = $state<YoutubeDetails | null>(null);
  let playing = $state(false);

  $effect(() => {
    const id = video?.id;
    details = null;
    playing = false;
    if (id === undefined) return;

    let cancelled = false;
    void loadYoutubeDetails(id).then((result) => {
      if (!cancelled) details = result;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if video && details}
  <div class="youtube-embed">
    <a class="youtube-header" href={url} target="_blank" rel="noopener noreferrer">
      <span class="youtube-site">{details.author ?? 'YouTube'}</span>
      <span class="youtube-title">{details.title}</span>
    </a>
    <div class="youtube-player">
      {#if playing}
        <iframe
          src={youtubePlayerUrl(video)}
          title={details.title}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen
        ></iframe>
      {:else}
        <button
          type="button"
          class="youtube-poster"
          aria-label={$i18n.t('timeline.playVideo', { name: details.title })}
          onclick={() => (playing = true)}
        >
          <img src={youtubeThumbnailUrl(video)} alt="" loading="lazy" />
          <span class="youtube-play" aria-hidden="true"><PlayIcon /></span>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .youtube-embed {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    max-width: var(--timeline-media-max);
    overflow: hidden;
  }

  .youtube-header {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
  }

  .youtube-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .youtube-title {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .youtube-header:hover .youtube-title {
    text-decoration: underline;
  }

  .youtube-player {
    aspect-ratio: 16 / 9;
    background: var(--surface-var-container);
    position: relative;
    width: 100%;
  }

  .youtube-player iframe,
  .youtube-poster {
    border: 0;
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  .youtube-poster {
    background: none;
    cursor: pointer;
    padding: 0;
  }

  .youtube-poster img {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .youtube-play {
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

  .youtube-play :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .youtube-poster:hover .youtube-play,
  .youtube-poster:focus-visible .youtube-play {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }
</style>
