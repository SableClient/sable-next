<script lang="ts">
  import { untrack } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';

  import { i18n } from '#lib/i18n.js';
  import { TILE_ATTRIBUTION, tileUrl } from '#lib/platform/map-tiles.js';

  interface Props {
    latitude: number | null;
    longitude: number | null;
    label: string;
    zoom?: number;
    onPick?: (latitude: number, longitude: number) => void;
  }

  let { latitude, longitude, label, zoom = 16, onPick }: Props = $props();

  const pinIcon = L.divIcon({
    className: 'location-marker',
    html: '<svg viewBox="0 0 24 32" width="25" height="33" aria-hidden="true"><path d="M12 0a12 12 0 0 0-12 12c0 8.4 12 20 12 20s12-11.6 12-20A12 12 0 0 0 12 0Z"/><circle cx="12" cy="12" r="4.5"/></svg>',
    iconSize: [25, 33],
    iconAnchor: [12, 33],
  });

  function leaflet(node: HTMLDivElement) {
    const start = untrack<[number, number] | null>(() =>
      latitude === null || longitude === null ? null : [latitude, longitude]
    );
    const picking = untrack(() => onPick !== undefined);

    const map = L.map(node, {
      attributionControl: true,
      keyboard: true,
      scrollWheelZoom: picking,
    }).setView(
      start ?? [20, 0],
      untrack(() => zoom)
    );

    L.tileLayer(tileUrl(), { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

    if (picking) map.on('click', (event) => onPick?.(event.latlng.lat, event.latlng.lng));

    let marker: L.Marker | null = null;
    $effect(() => {
      if (latitude === null || longitude === null) {
        marker?.remove();
        marker = null;
        return;
      }

      const coordinates: [number, number] = [latitude, longitude];
      if (marker === null) {
        const pin = L.marker(coordinates, {
          icon: pinIcon,
          alt: label,
          keyboard: false,
          draggable: picking,
        }).addTo(map);
        if (picking) {
          pin.on('dragend', () => {
            const moved = pin.getLatLng();
            onPick?.(moved.lat, moved.lng);
          });
        }
        marker = pin;
      } else {
        marker.setLatLng(coordinates);
      }

      marker.getElement()?.setAttribute('alt', label);
      map.panTo(coordinates, { animate: false });
    });

    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(node);

    return () => {
      observer.disconnect();
      map.remove();
    };
  }
</script>

<div
  class="location-map"
  role={onPick ? 'application' : 'img'}
  aria-label={onPick
    ? $i18n.t('composer.locationPickerAlt')
    : $i18n.t('timeline.locationMapAlt', { label })}
  {@attach leaflet}
></div>

<style>
  .location-map {
    aspect-ratio: 3 / 2;
    background: var(--surface-container);
    border-radius: var(--radius);
    width: 100%;
    z-index: 0;
  }

  .location-map :global(.location-marker svg) {
    fill: var(--primary-main);
  }

  .location-map :global(.location-marker circle) {
    fill: var(--primary-on-main);
  }

  .location-map :global(.leaflet-container) {
    background: var(--surface-container);
    font: inherit;
  }

  .location-map :global(.leaflet-control-attribution) {
    background: var(--surface-container);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .location-map :global(.leaflet-control-attribution a) {
    color: var(--primary-main);
  }
</style>
