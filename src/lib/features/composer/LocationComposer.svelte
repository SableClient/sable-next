<script lang="ts">
  import type { Component } from 'svelte';
  import CrosshairIcon from 'phosphor-svelte/lib/CrosshairIcon';
  import MapTrifoldIcon from 'phosphor-svelte/lib/MapTrifoldIcon';

  import { i18n } from '#lib/i18n.js';
  import { currentFix, locates } from '#lib/platform/geolocation.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { coordinate, coordinateText, geoUriFor } from './composer-location';

  interface Props {
    open?: boolean;
    onSend: (body: string, geoUri: string) => void;
  }

  let { open = $bindable(false), onSend }: Props = $props();
  let latitude = $state('');
  let longitude = $state('');
  let label = $state('');
  let locating = $state(false);
  let failure = $state<string | null>(null);

  let geoUri = $derived(geoUriFor(coordinate(latitude), coordinate(longitude)));
  let pin = $derived.by(() => {
    const north = coordinate(latitude);
    const east = coordinate(longitude);
    return geoUriFor(north, east) === null ? null : { north, east };
  });

  interface MapProps {
    latitude: number | null;
    longitude: number | null;
    label: string;
    zoom?: number;
    onPick?: (latitude: number, longitude: number) => void;
  }

  let map = $state.raw<Component<MapProps> | null>(null);
  let loadingMap = $state(false);
  let mapFailed = $state(false);

  async function showMap(): Promise<void> {
    loadingMap = true;
    mapFailed = false;
    try {
      const module = await import('#lib/features/room/LocationMap.svelte');
      map = module.default;
    } catch (error) {
      console.warn('[sable composer] loading the map failed', error);
      mapFailed = true;
    } finally {
      loadingMap = false;
    }
  }

  function pick(north: number, east: number): void {
    latitude = coordinateText(north);
    longitude = coordinateText(east);
  }

  function reset(): void {
    latitude = '';
    longitude = '';
    label = '';
    locating = false;
    failure = null;
  }

  async function locate(): Promise<void> {
    locating = true;
    failure = null;
    const result = await currentFix();
    locating = false;

    if (result.kind !== 'fix') {
      failure = $i18n.t(`composer.location${result.kind === 'denied' ? 'Denied' : 'Unavailable'}`);
      return;
    }

    latitude = String(result.fix.latitude);
    longitude = String(result.fix.longitude);
  }

  function send(): void {
    if (geoUri === null) return;
    const named = label.trim();
    const uri = geoUri;
    open = false;
    reset();
    onSend(named === '' ? uri.slice('geo:'.length) : named, uri);
  }

  function cancel(): void {
    open = false;
    reset();
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('composer.locationTitle')}>
  <div class="location-composer">
    <h2>{$i18n.t('composer.locationTitle')}</h2>
    <p class="explain">{$i18n.t('composer.locationExplain')}</p>

    {#if locates()}
      <Button variant="ghost" class="locate" disabled={locating} onclick={locate}>
        {#if locating}
          <Spinner small />
        {:else}
          <CrosshairIcon />
        {/if}
        {$i18n.t('composer.locationUseCurrent')}
      </Button>
    {/if}

    {#if failure}
      <Alert variant="critical" role="alert">{failure}</Alert>
    {/if}

    <div class="pair">
      <FormField fieldId="location-latitude" label={$i18n.t('composer.locationLatitude')}>
        <TextInput
          id="location-latitude"
          bind:value={latitude}
          inputmode="decimal"
          autocomplete="off"
        />
      </FormField>
      <FormField fieldId="location-longitude" label={$i18n.t('composer.locationLongitude')}>
        <TextInput
          id="location-longitude"
          bind:value={longitude}
          inputmode="decimal"
          autocomplete="off"
        />
      </FormField>
    </div>

    {#if map}
      {@const Map = map}
      <Map
        latitude={pin?.north ?? null}
        longitude={pin?.east ?? null}
        zoom={pin ? 16 : 2}
        label={label.trim()}
        onPick={pick}
      />
    {:else}
      <Button variant="ghost" class="reveal-map" disabled={loadingMap} onclick={showMap}>
        <MapTrifoldIcon />
        {loadingMap ? $i18n.t('composer.locationMapLoading') : $i18n.t('composer.locationShowMap')}
      </Button>
      {#if mapFailed}
        <Alert variant="critical" role="alert">{$i18n.t('composer.locationMapFailed')}</Alert>
      {/if}
    {/if}

    <FormField fieldId="location-label" label={$i18n.t('composer.locationLabel')}>
      <TextInput id="location-label" bind:value={label} autocomplete="off" />
    </FormField>

    <div class="actions">
      <Button variant="ghost" onclick={cancel}>{$i18n.t('composer.locationCancel')}</Button>
      <Button disabled={geoUri === null} onclick={send}>{$i18n.t('composer.locationSend')}</Button>
    </div>
  </div>
</DialogFrame>

<style>
  .location-composer {
    display: grid;
    gap: var(--space-400);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  :global(.locate),
  :global(.reveal-map) {
    gap: var(--space-200);
    justify-self: start;
  }

  .pair {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr 1fr;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
