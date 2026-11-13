<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';

  import { i18n } from '#lib/i18n.js';
  import { formatClockDuration } from '#lib/ui/clock-duration.js';
  import {
    recentMedia,
    recentMediaFile,
    recentMediaThumbnail,
    type RecentMedia,
  } from '#lib/platform/recent-media.js';

  interface Props {
    onFile: (file: File) => void;
  }

  let { onFile }: Props = $props();
  let items = $state.raw<RecentMedia[]>([]);
  let loading = $state<string | null>(null);
  const thumbnails = new SvelteMap<string, string>();

  $effect(() => {
    let live = true;
    const urls: string[] = [];
    void (async () => {
      const listed = await recentMedia();
      if (!live) return;
      items = listed;
      for (const media of listed) {
        const blob = await recentMediaThumbnail(media, 360);
        if (!live) return;
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        thumbnails.set(media.id, url);
      }
    })();
    return () => {
      live = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  });

  async function choose(media: RecentMedia): Promise<void> {
    if (loading) return;
    loading = media.id;
    try {
      onFile(await recentMediaFile(media));
    } catch (error) {
      console.debug('[sable files] recent media read failed', media.id, error);
    } finally {
      loading = null;
    }
  }
</script>

{#if items.length > 0}
  <ul
    class="recent-media scrollbar-hidden"
    aria-label={i18n.t('composer.recentMedia')}
    data-sheet-no-drag
  >
    {#each items as media (media.id)}
      <li>
        <button
          type="button"
          class={{ loading: loading === media.id }}
          aria-label={media.name}
          onclick={() => void choose(media)}
        >
          {#if thumbnails.has(media.id)}
            <img src={thumbnails.get(media.id)} alt="" />
          {/if}
          {#if media.kind === 'video'}
            <span class="duration">{formatClockDuration(Math.round(media.duration))}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .recent-media {
    display: flex;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    overflow-x: auto;
    padding: 0 var(--space-300);
    touch-action: pan-x;
  }

  li {
    flex: 0 0 auto;
  }

  button {
    background: var(--surface-container-hover);
    border: 0;
    border-radius: var(--radii-500);
    cursor: pointer;
    display: block;
    height: 9rem;
    overflow: hidden;
    padding: 0;
    position: relative;
    width: 9rem;
  }

  button.loading {
    opacity: 0.5;
  }

  img {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .duration {
    background: var(--media-scrim);
    border-radius: var(--radius);
    bottom: var(--space-100);
    color: var(--media-on-scrim);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    inset-inline-end: var(--space-100);
    padding: 0 var(--space-100);
    position: absolute;
  }
</style>
