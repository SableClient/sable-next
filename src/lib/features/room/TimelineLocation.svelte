<script lang="ts">
  import type { Component } from 'svelte';
  import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
  import MapTrifoldIcon from 'phosphor-svelte/lib/MapTrifoldIcon';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    body: string;
    geoUri: string;
    latitude: number | null;
    longitude: number | null;
  }

  let { body, geoUri, latitude, longitude }: Props = $props();
  let coordinates = $derived(
    latitude === null || longitude === null
      ? null
      : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
  );
  let label = $derived(body.trim() || $i18n.t('timeline.locationFallback'));

  interface MapProps {
    latitude: number;
    longitude: number;
    label: string;
  }

  let map = $state.raw<Component<MapProps> | null>(null);
  let loading = $state(false);
  let failed = $state(false);

  async function showMap(): Promise<void> {
    loading = true;
    failed = false;
    try {
      const module = await import('./LocationMap.svelte');
      map = module.default;
    } catch (error) {
      console.warn('[sable timeline] loading the map failed', error);
      failed = true;
    } finally {
      loading = false;
    }
  }
</script>

<div class="location">
  <a class="summary" href={geoUri}>
    <MapPinIcon class="pin" size={20} aria-hidden="true" />
    <span class="text">
      <span class="label">{label}</span>
      {#if coordinates}<span class="coordinates">{coordinates}</span>{/if}
    </span>
  </a>

  {#if latitude !== null && longitude !== null}
    {#if map}
      {@const Map = map}
      <Map {latitude} {longitude} {label} />
    {:else}
      <button type="button" class="reveal" disabled={loading} onclick={showMap}>
        <MapTrifoldIcon size={16} aria-hidden="true" />
        {loading ? $i18n.t('timeline.locationMapLoading') : $i18n.t('timeline.locationShowMap')}
      </button>
      {#if failed}
        <p class="failed">{$i18n.t('timeline.locationMapFailed')}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .location {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    max-width: var(--timeline-media-max);
    padding: var(--space-200) var(--space-300);
  }

  .summary {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--space-200);
    text-decoration: none;
  }

  .summary:hover {
    text-decoration: underline;
  }

  .summary :global(.pin) {
    color: var(--sable-primary-main);
    flex: none;
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .label {
    overflow-wrap: anywhere;
  }

  .coordinates {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .reveal {
    align-items: center;
    align-self: flex-start;
    background: none;
    border: none;
    border-radius: var(--radii-300);
    color: var(--sable-primary-main);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-100) 0;
  }

  .reveal:disabled {
    color: var(--sable-surface-var-on-container);
    cursor: progress;
  }

  .reveal:hover:not(:disabled) {
    text-decoration: underline;
  }

  .failed {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
