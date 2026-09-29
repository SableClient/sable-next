<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    variant?: 'outline' | 'primary';
    iconOnly?: boolean;
  }

  let {
    variant = 'outline',
    iconOnly = false,
    type = 'button',
    class: className = '',
    children,
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  class={['pill', `pill-${variant}`, { 'pill-icon-only': iconOnly }, className]}
>
  {@render children?.()}
</button>

<style>
  .pill {
    align-items: center;
    background: none;
    border: var(--border-width) solid var(--pill-line, var(--surface-container-line));
    border-radius: var(--radius-pill);
    color: var(--pill-ink, var(--bg-on-container));
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    justify-content: center;
    max-width: 100%;
    min-height: var(--pill-size, 1.5rem);
    padding: 0 var(--pill-padding, var(--space-250));
    white-space: nowrap;
  }

  .pill :global(svg) {
    color: var(--pill-icon, var(--sec-main));
    flex: none;
  }

  .pill-icon-only {
    min-width: var(--pill-size, 1.5rem);
    padding: 0;
  }

  .pill-primary {
    background: var(--pill-primary-ground, var(--primary-main));
    border-color: var(--pill-primary-line, transparent);
    color: var(--pill-primary-ink, var(--primary-on-main));
  }

  .pill-primary :global(svg) {
    color: currentcolor;
  }

  @media (pointer: coarse) {
    .pill {
      position: relative;
    }

    .pill::after {
      content: '';
      inset: calc((var(--pill-size, 1.5rem) - var(--target-hit)) / 2) 0;
      position: absolute;
    }
  }

  .pill:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .pill:disabled {
    opacity: var(--opacity-disabled, 0.38);
  }

  @media (hover: hover) and (pointer: fine) {
    .pill-outline:hover:not([aria-expanded='true']) {
      background: color-mix(in oklab, var(--pill-state, var(--bg-on-container)) 12%, transparent);
    }

    .pill-primary:hover:not([aria-expanded='true']) {
      background: var(--pill-primary-hover, var(--primary-main-hover));
    }
  }

  .pill-outline[aria-expanded='true'],
  .pill-outline[data-state='open'] {
    background: color-mix(in oklab, var(--pill-state, var(--bg-on-container)) 22%, transparent);
  }

  .pill-outline[aria-expanded='true'] :global(svg),
  .pill-outline[data-state='open'] :global(svg) {
    color: currentcolor;
  }
</style>
