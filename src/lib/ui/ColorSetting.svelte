<script lang="ts">
  import { Popover } from 'bits-ui';
  import { convertHsvToRgb, convertRgbToHsv, parseHex, serializeHex } from 'culori/fn';

  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { i18n } from '#lib/i18n.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';
  import { isHexColor } from '#lib/ui/hex-color.js';

  interface Props {
    label: string;
    value?: string;
    onCommit: () => void;
    onReset: () => void;
  }

  let { label, value = $bindable(''), onCommit, onReset }: Props = $props();
  let hue = $state(0);
  let saturation = $state(100);
  let brightness = $state(100);
  let trimmed = $derived(value.trim());
  let valid = $derived(isHexColor(trimmed));
  let swatchColor = $derived(valid ? trimmed : 'var(--bg-container)');

  function commit(): void {
    if (!valid) return;
    value = trimmed;
    onCommit();
  }

  function hexToHsv(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '');
    const rgb = /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)
      ? parseHex(`#${normalized}`)
      : undefined;
    if (!rgb) return [0, 100, 100];
    const color = convertRgbToHsv(rgb);
    return [Math.round(color.h ?? 0), Math.round(color.s * 100), Math.round(color.v * 100)];
  }

  function hsvToHex(nextHue: number, nextSaturation: number, nextBrightness: number): string {
    return serializeHex(
      convertHsvToRgb({ h: nextHue, s: nextSaturation / 100, v: nextBrightness / 100 })
    ).toUpperCase();
  }

  function update(nextHue = hue, nextSaturation = saturation, nextBrightness = brightness): void {
    hue = nextHue;
    saturation = nextSaturation;
    brightness = nextBrightness;
    value = hsvToHex(hue, saturation, brightness);
  }

  function syncPicker(): void {
    [hue, saturation, brightness] = hexToHsv(value);
  }

  function setSaturationAndBrightness(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    update(
      hue,
      Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * 100),
      Math.round((1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))) * 100)
    );
  }
</script>

<div class="color-setting">
  <span>{label}</span>
  <div class="color-controls">
    <Popover.Root
      onOpenChange={(next) => {
        if (next) syncPicker();
        else commit();
      }}
    >
      <Popover.Trigger
        class="swatch-button"
        aria-label={i18n.t('settings.colorChoose', { label })}
        style={`background: ${swatchColor}`}
      >
        <span aria-hidden="true"></span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          class="color-popover"
          {...overlayLayer()}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={collisionPadding()}
        >
          <button
            type="button"
            class="saturation-picker"
            style:--picker-color={hsvToHex(hue, 100, 100)}
            aria-label={i18n.t('settings.colorSaturation', { label })}
            onpointerdown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.focus();
              setSaturationAndBrightness(event);
            }}
            onpointermove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                setSaturationAndBrightness(event);
            }}
          >
            <span
              class="picker-cursor"
              style:left={`${String(saturation)}%`}
              style:top={`${String(100 - brightness)}%`}
            ></span>
          </button>
          <input
            class="hue-slider"
            type="range"
            aria-label={i18n.t('settings.colorHue', { label })}
            min="0"
            max="360"
            value={hue}
            oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
              update(Number(event.currentTarget.value));
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <TextInput
      bind:value
      aria-label={i18n.t('settings.colorHexLabel', { label })}
      placeholder={i18n.t('settings.colorHexPlaceholder')}
      maxlength={7}
      onchange={commit}
    />
    <Button variant="ghost" size="small" disabled={!value} onclick={onReset}
      >{i18n.t('common.reset')}</Button
    >
  </div>
</div>

<style>
  .color-setting {
    display: grid;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
  }

  .color-controls {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  :global(.swatch-button) {
    border: calc(var(--border-width) * 2) solid var(--focus-ring);
    border-radius: 50%;
    cursor: pointer;
    height: var(--control-height-medium);
    padding: 0;
    width: var(--control-height-medium);
  }

  .color-controls :global(.text-input) {
    font-family: monospace;
    text-transform: uppercase;
    width: 7rem;
  }

  :global(.color-popover) {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    padding: var(--space-400);
    width: 14rem;
  }

  .saturation-picker {
    background-color: var(--picker-color);
    background-image:
      linear-gradient(to top, var(--picker-black), transparent),
      linear-gradient(to right, var(--picker-white), transparent);
    border: 0;
    cursor: crosshair;
    height: 10rem;
    padding: 0;
    position: relative;
    width: 100%;
  }

  .picker-cursor {
    border: calc(var(--border-width) * 2) solid var(--bg-container);
    border-radius: 50%;
    box-shadow: 0 0 0 var(--border-width) var(--bg-on-container);
    height: 0.75rem;
    position: absolute;
    transform: translate(-50%, -50%);
    width: 0.75rem;
  }

  .hue-slider {
    --hue-track: 0.75rem;
    --hue-thumb: 1rem;
    --hue-strip: linear-gradient(
      to right,
      hwb(0deg 0% 0%),
      hwb(60deg 0% 0%),
      hwb(120deg 0% 0%),
      hwb(180deg 0% 0%),
      hwb(240deg 0% 0%),
      hwb(300deg 0% 0%),
      hwb(360deg 0% 0%)
    );

    appearance: none;
    background: transparent;
    cursor: pointer;
    height: var(--hue-thumb);
    margin: var(--space-400) 0 0;
    width: 100%;
  }

  .hue-slider::-webkit-slider-runnable-track {
    background: var(--hue-strip);
    border-radius: var(--radii-400);
    height: var(--hue-track);
  }

  .hue-slider::-moz-range-track {
    background: var(--hue-strip);
    border-radius: var(--radii-400);
    height: var(--hue-track);
  }

  .hue-slider::-webkit-slider-thumb {
    appearance: none;
    background: transparent;
    border: calc(var(--border-width) * 2) solid var(--bg-container);
    border-radius: 50%;
    box-shadow: 0 0 0 var(--border-width) var(--bg-on-container);
    height: var(--hue-thumb);
    margin-top: calc((var(--hue-track) - var(--hue-thumb)) / 2);
    width: var(--hue-thumb);
  }

  .hue-slider::-moz-range-thumb {
    background: transparent;
    border: calc(var(--border-width) * 2) solid var(--bg-container);
    border-radius: 50%;
    box-shadow: 0 0 0 var(--border-width) var(--bg-on-container);
    height: var(--hue-thumb);
    width: var(--hue-thumb);
  }

  .hue-slider:focus-visible {
    outline: calc(var(--border-width) * 2) solid var(--focus-ring);
    outline-offset: var(--border-width);
  }
</style>
