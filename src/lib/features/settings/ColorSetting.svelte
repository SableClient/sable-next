<script lang="ts">
  import { Popover } from 'bits-ui';

  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    label: string;
    value?: string;
    saving?: boolean;
    onSave: () => void;
    onReset: () => void;
  }

  let { label, value = $bindable(''), saving = false, onSave, onReset }: Props = $props();
  let hue = $state(0);
  let saturation = $state(100);
  let brightness = $state(100);
  let valid = $derived(/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value));
  let swatchColor = $derived(valid ? value : 'var(--sable-bg-container)');

  function hexToHsv(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '');
    const expanded = normalized.length === 3 ? normalized.replace(/(.)/g, '$1$1') : normalized;
    if (!/^[0-9a-f]{6}$/i.test(expanded)) return [0, 100, 100];
    const rgb = [0, 2, 4].map(
      (offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255
    );
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    const delta = max - min;
    const hue =
      delta === 0
        ? 0
        : ((rgb.indexOf(max) * 2 +
            (rgb[(rgb.indexOf(max) + 1) % 3] - rgb[(rgb.indexOf(max) + 2) % 3]) / delta) *
            60 +
            360) %
          360;
    return [
      Math.round(hue),
      max === 0 ? 0 : Math.round((delta / max) * 100),
      Math.round(max * 100),
    ];
  }

  function hsvToHex(nextHue: number, nextSaturation: number, nextBrightness: number): string {
    const chroma = (nextBrightness / 100) * (nextSaturation / 100);
    const x = chroma * (1 - Math.abs(((nextHue / 60) % 2) - 1));
    const match = nextBrightness / 100 - chroma;
    const [red, green, blue] =
      nextHue < 60
        ? [chroma, x, 0]
        : nextHue < 120
          ? [x, chroma, 0]
          : nextHue < 180
            ? [0, chroma, x]
            : nextHue < 240
              ? [0, x, chroma]
              : nextHue < 300
                ? [x, 0, chroma]
                : [chroma, 0, x];
    return `#${[red, green, blue]
      .map((channel) =>
        Math.round((channel + match) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')}`.toUpperCase();
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
      }}
    >
      <Popover.Trigger
        class="swatch-button"
        aria-label={`Choose ${label}`}
        style={`background: ${swatchColor}`}
      >
        <span aria-hidden="true"></span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="color-popover" side="bottom" align="start" sideOffset={8}>
          <button
            type="button"
            class="saturation-picker"
            style:--picker-color={hsvToHex(hue, 100, 100)}
            aria-label={`${label} saturation and brightness`}
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
            aria-label={`${label} hue`}
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
    <TextInput bind:value aria-label={`${label} hex value`} placeholder="Hex value" maxlength={7} />
    <Button size="small" disabled={!valid} loading={saving} onclick={onSave}>Save</Button>
    <Button variant="danger" size="small" disabled={!value} onclick={onReset}>Reset</Button>
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
    border: calc(var(--border-width) * 2) solid var(--sable-focus-ring);
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
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    padding: var(--space-400);
    width: 14rem;
    z-index: var(--layer-popover);
  }

  .saturation-picker {
    background-color: var(--picker-color);
    background-image:
      linear-gradient(to top, var(--sable-picker-black), transparent),
      linear-gradient(to right, var(--sable-picker-white), transparent);
    border: 0;
    cursor: crosshair;
    height: 10rem;
    padding: 0;
    position: relative;
    width: 100%;
  }

  .picker-cursor {
    border: calc(var(--border-width) * 2) solid var(--sable-bg-container);
    border-radius: 50%;
    box-shadow: 0 0 0 var(--border-width) var(--sable-bg-on-container);
    height: 0.75rem;
    position: absolute;
    transform: translate(-50%, -50%);
    width: 0.75rem;
  }

  .hue-slider {
    accent-color: var(--sable-primary-main);
    margin-top: var(--space-400);
    width: 100%;
  }
</style>
