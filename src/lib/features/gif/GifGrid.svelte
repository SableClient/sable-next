<script lang="ts">
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import HeartStraightIcon from 'phosphor-svelte/lib/HeartStraightIcon';

  import { i18n } from '#lib/i18n.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { favoriteGifs, isFavorite, recentGifs, toggleFavorite } from './favorites.svelte';
  import { GifSearch } from './gif-search.svelte';
  import {
    gifProvider,
    type GifProviderSetting,
    type GifResult,
    type GifsConfig,
  } from './providers';

  interface Props {
    config: GifsConfig;
    providerSetting: GifProviderSetting;
    query: string;
    onPick: (gif: GifResult) => void;
  }

  let { config, providerSetting, query, onPick }: Props = $props();

  const search = new GifSearch();

  let favorites = $derived(favoriteGifs());
  let provider = $derived(gifProvider(config, providerSetting));

  $effect(() => {
    const apiKey = provider.apiKey(config);
    if (apiKey === null) return;
    search.search(provider, apiKey, query);
    return () => {
      search.cancel();
    };
  });

  let searching = $derived(query.trim() !== '');
  let recent = $derived(recentGifs());
  let empty = $derived(
    searching ? search.results.length === 0 : recent.length + favorites.length === 0
  );

  function star(event: MouseEvent, gif: GifResult): void {
    event.stopPropagation();
    toggleFavorite(gif);
  }
</script>

{#snippet tiles(gifs: readonly GifResult[])}
  <ul>
    {#each gifs as gif (gif.mediaUrl)}
      {@const kept = isFavorite(favorites, gif)}
      <li>
        <button
          type="button"
          class="gif-cell"
          title={gif.title}
          aria-label={gif.title}
          onclick={() => {
            onPick(gif);
          }}
        >
          <img
            src={gif.previewUrl}
            alt=""
            width="4"
            height="3"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />
        </button>
        <button
          type="button"
          class="gif-star choice"
          aria-pressed={kept}
          aria-label={kept ? $i18n.t('composer.gifUnfavorite') : $i18n.t('composer.gifFavorite')}
          onclick={(event) => {
            star(event, gif);
          }}
        >
          {#if kept}
            <HeartIcon weight="fill" />
          {:else}
            <HeartStraightIcon />
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="gif-grid">
  {#if search.loading}
    <div class="gif-note"><Spinner /></div>
  {:else if search.failed}
    <div class="gif-note">{$i18n.t('composer.gifSearchFailed')}</div>
  {:else if empty}
    <div class="gif-note">
      {searching ? $i18n.t('composer.gifNoMatches') : $i18n.t('composer.gifEmptyFavorites')}
    </div>
  {:else}
    {#if searching}
      {@render tiles(search.results)}
    {:else}
      {#if recent.length > 0}
        <h3>{$i18n.t('composer.gifRecent')}</h3>
        {@render tiles(recent)}
      {/if}
      {#if favorites.length > 0}
        <h3>{$i18n.t('composer.gifFavorites')}</h3>
        {@render tiles(favorites)}
      {/if}
    {/if}
    <p class="gif-attribution">
      {$i18n.t('composer.gifAttribution', { provider: provider.label })}
    </p>
  {/if}
</div>

<style>
  .gif-grid {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-200);
  }

  .gif-grid h3 {
    font-size: var(--font-size-small);
    margin: var(--space-100) 0;
  }

  .gif-grid ul {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(2, minmax(0, 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .gif-grid li {
    position: relative;
  }

  .gif-cell {
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    display: block;
    overflow: hidden;
    padding: 0;
    width: 100%;
  }

  .gif-cell img {
    aspect-ratio: 4 / 3;
    display: block;
    height: auto;
    object-fit: cover;
    width: 100%;
  }

  .gif-cell:hover,
  .gif-cell:focus-visible {
    outline: var(--border-width) solid var(--primary-main);
  }

  .gif-star {
    align-items: center;
    background: var(--surface-container);
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: var(--space-100);
    position: absolute;
    right: 0.25rem;
    top: 0.25rem;
  }

  .gif-star :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .gif-attribution {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-300) 0 0;
  }

  .gif-note {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex: 1;
    font-size: var(--font-size-small);
    justify-content: center;
    padding: var(--space-400);
    text-align: center;
  }
</style>
