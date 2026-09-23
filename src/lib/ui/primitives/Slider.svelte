<script lang="ts">
  import { Slider } from 'bits-ui';

  interface Props {
    min?: number;
    max: number;
    step?: number;
    disabled?: boolean;
    label: string;
    value: number;
    oninput?: (value: number) => void;
    oncommit?: (value: number) => void;
  }

  let {
    min = 1,
    max = 2,
    step = 1,
    disabled = false,
    label,
    value = $bindable(1),
    oninput,
    oncommit,
  }: Props = $props();
</script>

<Slider.Root
  type="single"
  bind:value
  {min}
  {max}
  {step}
  {disabled}
  class="slider"
  onValueChange={(next) => oninput?.(next)}
  onValueCommit={(next) => oncommit?.(next)}
>
  <span class="slider-track">
    <Slider.Range class="slider-range" />
  </span>
  <Slider.Thumb index={0} class="slider-thumb" aria-label={label} />
</Slider.Root>

<style>
  :global(.slider) {
    align-items: center;
    cursor: pointer;
    display: flex;
    min-height: var(--target-hit);
    position: relative;
    touch-action: none;
    user-select: none;
    width: 100%;
  }

  :global(.slider[data-disabled]) {
    cursor: default;
    filter: grayscale(0.3);
    opacity: 0.8;
  }

  .slider-track {
    background: var(--surface-container);
    border: var(--border-width-300) solid var(--surface-container-line);
    border-radius: var(--radius);
    flex: 1;
    height: var(--space-300);
    overflow: hidden;
    position: relative;
  }

  :global(.slider:hover) .slider-track {
    background: var(--surface-container-hover);
  }

  :global(.slider-range) {
    background: var(--primary-container);
    height: 100%;
    position: absolute;
  }

  :global(.slider:hover .slider-range) {
    background: var(--primary-container-hover);
  }

  :global(.slider-thumb) {
    background: var(--primary-main-line);
    border: var(--border-width-300) solid var(--surface-container-line);
    border-radius: 100%;
    display: block;
    height: var(--space-500);
    width: var(--space-500);
  }

  :global(.slider:hover .slider-thumb),
  :global(.slider-thumb[data-active]) {
    background: var(--primary-main-active);
  }

  :global(.slider-thumb:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-width);
  }
</style>
