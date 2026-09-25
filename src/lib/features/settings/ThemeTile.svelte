<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import type { Snippet } from 'svelte';

  import { safeSwatch } from '#lib/settings/theme-file.js';

  interface Props {
    name: string;
    detail?: string;
    swatches: readonly string[];
    radius?: string;
    innerRadius?: string;
    selected?: boolean;
    role?: 'radio' | 'button';
    tabindex?: number;
    keyshortcuts?: string;
    onselect?: () => void;
    trailing?: Snippet;
    actions?: Snippet;
  }

  let {
    name,
    detail,
    swatches,
    radius,
    innerRadius,
    selected = false,
    role = 'radio',
    tabindex,
    keyshortcuts,
    onselect,
    trailing,
    actions,
  }: Props = $props();

  let colors = $derived(swatches.map((color) => (safeSwatch(color) ? color : undefined)));
</script>

<div class="tile" class:selected class:has-trailing={trailing !== undefined}>
  <button
    type="button"
    class="tile-hit"
    {role}
    aria-checked={role === 'radio' ? selected : undefined}
    aria-keyshortcuts={keyshortcuts}
    {tabindex}
    title={name}
    onclick={onselect}
  >
    <span
      class="preview"
      aria-hidden="true"
      style:--tile-bg={colors[0]}
      style:--tile-surface={colors[1]}
      style:--tile-accent={colors[2]}
      style:--tile-ink={colors[3]}
      style:--tile-radius={radius}
      style:--tile-radius-inner={innerRadius}
    >
      <span class="preview-side">
        <span class="preview-dot"></span>
        <span class="preview-dot"></span>
        <span class="preview-dot"></span>
      </span>
      <span class="preview-main">
        <span class="preview-line wide"></span>
        <span class="preview-bubble"></span>
        <span class="preview-line"></span>
        <span class="preview-button"></span>
      </span>
      {#if selected}<span class="tile-check"><CheckIcon weight="bold" /></span>{/if}
    </span>
    <span class="tile-name">{name}</span>
    {#if detail}<span class="tile-detail">{detail}</span>{/if}
  </button>
  {#if trailing}<div class="tile-trailing">
      <div class="tile-trailing-row">{@render trailing()}</div>
    </div>{/if}
  {#if actions}<div class="tile-actions">{@render actions()}</div>{/if}
</div>

<style>
  .tile {
    display: grid;
    gap: var(--space-200);
    grid-template-rows: 1fr auto;
    height: 100%;
    min-width: 0;
    position: relative;
  }

  .tile-hit {
    align-content: start;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: var(--space-100);
    min-width: 0;
    padding: 0;
    text-align: start;
  }

  .tile-hit:focus-visible {
    outline: none;
  }

  .preview {
    aspect-ratio: 16 / 10;
    background: var(--tile-bg, var(--bg-container));
    border-radius: var(--tile-radius, var(--radius));
    box-shadow:
      0 0 0 var(--border-width) var(--surface-container-line),
      var(--shadow-e100);
    display: grid;
    grid-template-columns: 28% 1fr;
    overflow: hidden;
    position: relative;
    transition:
      box-shadow var(--duration-fast) var(--ease-smooth-out),
      transform var(--duration-fast) var(--ease-smooth-out);
  }

  .selected .preview {
    box-shadow:
      0 0 0 var(--border-width-600) var(--primary-main),
      var(--shadow-e100);
  }

  .tile-hit:hover .preview {
    transform: translateY(calc(var(--border-width) * -2));
  }

  .tile-hit:focus-visible .preview {
    box-shadow:
      0 0 0 var(--focus-ring-width) var(--focus-ring),
      var(--shadow-e100);
  }

  .preview-side {
    background: var(--tile-surface, var(--surface-container));
    display: grid;
    gap: 10%;
    grid-auto-rows: min-content;
    padding: 16% 26%;
  }

  .preview-dot {
    aspect-ratio: 1;
    background: var(--tile-ink, var(--bg-on-container));
    border-radius: var(--radii-round);
    opacity: 0.35;
  }

  .preview-main {
    display: grid;
    gap: 9%;
    grid-auto-rows: min-content;
    padding: 12% 12% 0;
  }

  .preview-line,
  .preview-bubble,
  .preview-button {
    border-radius: var(--radii-pill);
    display: block;
  }

  .preview-line {
    background: var(--tile-ink, var(--bg-on-container));
    block-size: 0.3rem;
    inline-size: 55%;
    opacity: 0.55;
  }

  .preview-line.wide {
    inline-size: 80%;
  }

  .preview-bubble {
    background: var(--tile-surface, var(--surface-container));
    block-size: 0.9rem;
    border-radius: var(--tile-radius, var(--radius));
    inline-size: 90%;
  }

  .preview-button {
    background: var(--tile-accent, var(--primary-main));
    block-size: 0.5rem;
    border-radius: var(--tile-radius-inner, var(--radius-inner));
    inline-size: 38%;
    justify-self: end;
  }

  .tile-check {
    align-items: center;
    background: var(--primary-main);
    block-size: 1.5rem;
    border-radius: var(--radii-round);
    color: var(--primary-on-main);
    display: flex;
    inline-size: 1.5rem;
    inset-block-start: var(--space-150);
    inset-inline-end: var(--space-150);
    justify-content: center;
    position: absolute;
  }

  .tile-check :global(svg) {
    block-size: var(--icon-size-small);
    inline-size: var(--icon-size-small);
  }

  .tile-name {
    align-content: center;
    display: grid;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    min-block-size: var(--control-height-300);
    overflow-wrap: anywhere;
  }

  .has-trailing .tile-name {
    padding-inline-end: calc(var(--control-height-300) + var(--space-100));
  }

  .tile-trailing {
    aspect-ratio: 16 / 10;
    inset-block-start: 0;
    inset-inline: 0;
    pointer-events: none;
    position: absolute;
  }

  .tile-trailing-row {
    align-items: center;
    block-size: var(--control-height-300);
    display: flex;
    inset-block-start: calc(100% + var(--space-100));
    inset-inline-end: 0;
    pointer-events: auto;
    position: absolute;
  }

  .selected .tile-name {
    font-weight: var(--font-weight-bold);
  }

  .tile-detail {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  .tile-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }
</style>
