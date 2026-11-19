<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import { i18n } from '#lib/i18n.js';
  import { readText, writeText } from '#lib/platform/local-json.js';
  import { isAndroid } from '#lib/platform/os.js';
  import { formatClockDuration } from '#lib/ui/clock-duration.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import {
    recentMedia,
    recentMediaFile,
    recentMediaThumbnail,
    type MediaAccess,
    type RecentMedia,
  } from '#lib/platform/recent-media.js';

  const DECLINED_KEY = 'sable-recent-media-declined';

  interface Props {
    onFile: (file: File) => void;
  }

  let { onFile }: Props = $props();
  let items = $state.raw<RecentMedia[]>([]);
  let loading = $state<string | null>(null);
  let access = $state<MediaAccess | null>(null);
  let declined = $state(readText(DECLINED_KEY) !== null);
  const thumbnails = new SvelteMap<string, string>();
  const urls: string[] = [];
  let live = true;

  async function list(request: boolean): Promise<void> {
    const listed = await recentMedia(24, request);
    if (!live) return;
    access = listed.access;
    items = listed.items;
    for (const media of listed.items) {
      const blob = await recentMediaThumbnail(media, 360);
      if (!live) return;
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      thumbnails.set(media.id, url);
    }
  }

  onMount(() => {
    void list(false);
    return () => {
      live = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  });

  function decline(): void {
    declined = true;
    writeText(DECLINED_KEY, '1');
  }

  async function allow(): Promise<void> {
    await list(true);
    // A refusal still reads as unasked on Android, so the offer would come straight back.
    if (access === 'unasked') decline();
  }

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

{#if access === 'unasked' && !declined}
  <div class="offer">
    <p>{i18n.t('composer.recentMediaOffer')}</p>
    <p class="hint">{i18n.t('composer.recentMediaOfferHint')}</p>
    <div class="offer-actions">
      <Button size="small" variant="ghost" onclick={decline}>
        {i18n.t('composer.recentMediaDecline')}
      </Button>
      <Button size="small" onclick={() => void allow()}>
        {i18n.t('composer.recentMediaAllow')}
      </Button>
    </div>
  </div>
{:else if items.length > 0}
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
  {#if access === 'limited'}
    <p class="hint limited">
      {i18n.t('composer.recentMediaLimited')}
      {#if isAndroid()}
        <Button size="small" variant="ghost" onclick={() => void list(true)}>
          {i18n.t('composer.recentMediaChange')}
        </Button>
      {/if}
    </p>
  {/if}
{/if}

<style>
  .offer {
    display: grid;
    gap: var(--space-100);
    padding: 0 var(--space-300);
  }

  .offer p,
  .limited {
    margin: 0;
  }

  .hint {
    font-size: var(--font-size-small);
  }

  .limited {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
    padding: 0 var(--space-300);
  }

  .offer-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }

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
