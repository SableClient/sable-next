<script lang="ts">
  interface Props {
    min?: number;
    max: number;
    disabled?: boolean;
    label: string;
    value: number;
  }

  let { min = 1, max = 2, disabled = false, label, value = $bindable(1) }: Props = $props();
  let progress = $derived(((value - min) / (max - min)) * 100);
</script>

<input
  type="range"
  {min}
  {max}
  class="max-selection-slider"
  bind:value
  style={`--progress: ${progress}%`}
  {disabled}
  aria-label={label}
/>

<style>
  :global(.max-selection-slider) {
    appearance: none;
    background: linear-gradient(
      to right,
      var(--primary-container) 0%,
      var(--primary-container) var(--progress),
      var(--surface-container) var(--progress),
      var(--surface-container) 100%
    );
    border: var(--border-width-300) solid var(--surface-container-line);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--space-300);
    width: 100%;
  }

  :global(.max-selection-slider:hover) {
    background: linear-gradient(
      to right,
      var(--primary-container-hover) 0%,
      var(--primary-container-hover) var(--progress),
      var(--surface-container-hover) var(--progress),
      var(--surface-container-hover) 100%
    );
  }

  :global(.max-selection-slider:disabled) {
    filter: grayscale(0.3);
    opacity: 0.8;
  }

  :global(.max-selection-slider::-webkit-slider-runnable-track),
  :global(.max-selection-slider::-moz-range-track) {
    background: transparent;
    border-radius: var(--radius);
  }

  :global(.max-selection-slider::-webkit-slider-thumb),
  :global(.max-selection-slider::-moz-range-thumb) {
    appearance: none;
    background: var(--primary-main-line);
    border: var(--border-width-300) solid var(--surface-container-line);
    border-radius: 100%;
    cursor: pointer;
    height: var(--space-500);
    width: var(--space-500);
  }

  :global(.max-selection-slider:hover::-webkit-slider-thumb),
  :global(.max-selection-slider:hover::-moz-range-thumb) {
    background: var(--primary-main-active);
  }
</style>
