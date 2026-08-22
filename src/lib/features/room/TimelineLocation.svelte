<script lang="ts">
  import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';

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
  // Fetching map tiles would hand the sender's location to a third party, so
  // the `geo:` URI defers to the platform's own map.
  let label = $derived(body.trim() || $i18n.t('timeline.locationFallback'));
</script>

<a class="location" href={geoUri}>
  <MapPinIcon class="pin" size={20} aria-hidden="true" />
  <span class="text">
    <span class="label">{label}</span>
    {#if coordinates}<span class="coordinates">{coordinates}</span>{/if}
  </span>
</a>

<style>
  .location {
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    display: inline-flex;
    gap: 0.5rem;
    max-width: var(--timeline-media-max);
    padding: 0.5rem 0.75rem;
    text-decoration: none;
  }

  .location:hover {
    background: var(--sable-surface-container-hover);
  }

  .location :global(.pin) {
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
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
</style>
