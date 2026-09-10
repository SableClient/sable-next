<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import './tooltip.css';

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
    <BitsTooltip.Content class="tooltip" {side} {align} sideOffset={8}>
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
    color: var(--sec-main);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: var(--space-050);
  }

  .tooltip-trigger-icon:hover {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  .tooltip-trigger-icon[data-state='open'] {
    background: var(--surface-container-active);
    color: var(--surface-on-container);
  }

  .tooltip-trigger-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .tooltip-trigger-inline {
    align-items: baseline;
    border-radius: var(--radii-200);
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
    color: var(--surface-on-container);
  }

  .tooltip-trigger:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (prefers-reduced-motion: no-preference) {
    .tooltip-trigger {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        color var(--motion-normal) var(--motion-easing-standard),
        box-shadow var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
