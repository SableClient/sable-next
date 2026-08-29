<script lang="ts">
  import { untrack } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    latitude: number;
    longitude: number;
    label: string;
  }

  let { latitude, longitude, label }: Props = $props();

  const pinIcon = L.divIcon({
    className: 'location-marker',
    html: '<svg viewBox="0 0 24 32" width="25" height="33" aria-hidden="true"><path d="M12 0a12 12 0 0 0-12 12c0 8.4 12 20 12 20s12-11.6 12-20A12 12 0 0 0 12 0Z"/><circle cx="12" cy="12" r="4.5"/></svg>',
    iconSize: [25, 33],
    iconAnchor: [12, 33],
  });

  function leaflet(node: HTMLDivElement) {
    const view = untrack<[number, number]>(() => [latitude, longitude]);
    const alt = untrack(() => label);

    const map = L.map(node, {
      attributionControl: true,
      keyboard: true,
      scrollWheelZoom: false,
    }).setView(view, 16);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    L.marker(view, { icon: pinIcon, alt, keyboard: false }).addTo(map);

    return () => {
      map.remove();
    };
  }
</script>

<div
  class="location-map"
  role="img"
  aria-label={$i18n.t('timeline.locationMapAlt', { label })}
  {@attach leaflet}
></div>

<style>
  .location-map {
    aspect-ratio: 3 / 2;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    width: 100%;
    z-index: 0;
  }

  .location-map :global(.location-marker svg) {
    fill: var(--sable-primary-main);
  }

  .location-map :global(.location-marker circle) {
    fill: var(--sable-primary-on-main);
  }

  .location-map :global(.leaflet-container) {
    background: var(--sable-surface-container);
    font: inherit;
  }

  .location-map :global(.leaflet-control-attribution) {
    background: var(--sable-surface-container);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .location-map :global(.leaflet-control-attribution a) {
    color: var(--sable-primary-main);
  }
</style>
