<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  export type TooltipVariant = 'icon' | 'inline';
  type TooltipSide = 'top' | 'right' | 'bottom' | 'left';
  type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

  interface Props {
    label: string;
    variant?: TooltipVariant;
    side?: TooltipSide;
    align?: 'start' | 'center' | 'end';
    class?: ClassValue;
    trigger?: TriggerSnippet;
    children?: Snippet;
  }

  let {
    label,
    variant = 'icon',
    side = 'top',
    align = 'center',
    class: className = '',
    trigger,
    children,
  }: Props = $props();
</script>

{#snippet defaultTrigger({ props }: { props: Record<string, unknown> })}
  <button
    {...props}
    class={['tooltip-trigger', `tooltip-trigger-${variant}`, className]}
    type="button"
    aria-label={variant === 'icon' ? label : undefined}
  >
    {@render children?.()}
  </button>
{/snippet}

<BitsTooltip.Root>
  <BitsTooltip.Trigger child={trigger ?? defaultTrigger} />
  <BitsTooltip.Portal>
    <BitsTooltip.Content class="sable-tooltip" {side} {align} sideOffset={8}>
      {label}
    </BitsTooltip.Content>
  </BitsTooltip.Portal>
</BitsTooltip.Root>

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
  }

  .tooltip-trigger-icon:hover,
  .tooltip-trigger-icon[data-state='open'] {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .tooltip-trigger-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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
    color: var(--sable-bg-on-container);
  }

  .tooltip-trigger:focus-visible {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
    outline: none;
  }

  :global(.sable-tooltip) {
    animation: tooltip-in var(--motion-slow) var(--motion-easing-emphasized) both;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    max-width: min(15rem, calc(100vw - 2rem));
    overflow-wrap: anywhere;
    padding: 0.5rem 0.625rem;
    white-space: normal;
    z-index: var(--layer-tooltip);
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem) scale(0.96);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .tooltip-trigger {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        color var(--motion-normal) var(--motion-easing-standard),
        box-shadow var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.sable-tooltip) {
      animation: none;
    }
  }
</style>
