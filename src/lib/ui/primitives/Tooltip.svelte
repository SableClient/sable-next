<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  export type TooltipVariant = 'icon' | 'inline';

  interface Props {
    label: string;
    variant?: TooltipVariant;
    class?: ClassValue;
    children: Snippet;
  }

  let { label, variant = 'icon', class: className = '', children }: Props = $props();
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
  <button
    {...props}
    class={['tooltip-trigger', `tooltip-trigger-${variant}`, className]}
    type="button"
    aria-label={label}
  >
    {@render children()}
  </button>
{/snippet}

<BitsTooltip.Provider delayDuration={0} skipDelayDuration={0}>
  <BitsTooltip.Root>
    <BitsTooltip.Trigger child={trigger} />
    <BitsTooltip.Portal>
      <BitsTooltip.Content class="sable-tooltip" side="top" align="end" sideOffset={8}>
        {label}
      </BitsTooltip.Content>
    </BitsTooltip.Portal>
  </BitsTooltip.Root>
</BitsTooltip.Provider>

<style>
  .tooltip-trigger {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 50%;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: 0.125rem;
    transition:
      background-color var(--motion-normal) ease,
      color var(--motion-normal) ease,
      box-shadow var(--motion-normal) ease;
  }

  .tooltip-trigger-icon {
    border-radius: 50%;
    padding: 0.125rem;
  }

  .tooltip-trigger-icon:hover,
  .tooltip-trigger-icon[data-state='open'] {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .tooltip-trigger-icon :global(svg) {
    height: 1.125rem;
    width: 1.125rem;
  }

  .tooltip-trigger-inline {
    align-items: baseline;
    border-radius: 0.125rem;
    color: inherit;
    cursor: default;
    display: inline;
    font: inherit;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  .tooltip-trigger-inline:hover,
  .tooltip-trigger-inline[data-state='open'] {
    background: transparent;
    color: var(--sable-bg-on-container);
  }

  .tooltip-trigger:focus-visible {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
    outline: none;
  }

  :global(.sable-tooltip) {
    animation: tooltip-in calc(var(--motion-slow) * 1.5) var(--motion-easing-emphasized) both;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: 0 0.5rem 1.25rem var(--sable-shadow);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    max-width: calc(100vw - 2rem);
    overflow-wrap: anywhere;
    padding: 0.75rem;
    white-space: normal;
    width: 15rem;
    z-index: var(--layer-popover);
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem) scale(0.96);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tooltip-trigger,
    :global(.sable-tooltip) {
      animation: none;
      transition: none;
    }
  }
</style>
