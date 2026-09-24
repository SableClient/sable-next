<script lang="ts">
  import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';

  interface Props {
    colors: readonly string[];
  }

  let { colors }: Props = $props();
</script>

<span class="swatches" aria-hidden="true">
  {#each colors as color, index (index)}
    <span class="swatch" style:background={color}></span>
  {:else}
    <PaletteIcon />
  {/each}
</span>

<style>
  .swatches {
    color: var(--surface-var-on-container);
    display: flex;
    flex: none;
  }

  .swatch {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-round);
    height: 1.25rem;
    width: 1.25rem;
  }

  .swatch + .swatch {
    margin-inline-start: calc(var(--space-150) * -1);
  }
</style>
