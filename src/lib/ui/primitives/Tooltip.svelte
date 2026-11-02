<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';

  import { tooltipHost, type TooltipPayload } from './TooltipHost.svelte';
  import TooltipProvider, { tooltipProvided } from './TooltipProvider.svelte';
  import './tooltip.css';

  export type TooltipVariant = 'icon' | 'inline';
  type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

  interface Props {
    label?: string;
    multiline?: boolean;
    variant?: TooltipVariant;
    side?: TooltipPayload['side'];
    align?: TooltipPayload['align'];
    class?: ClassValue;
    customAnchor?: HTMLElement | null;
    open?: boolean;
    disabled?: boolean;
    trigger?: TriggerSnippet;
    content?: Snippet;
    children?: Snippet;
  }

  let {
    label = '',
    multiline = false,
    variant = 'icon',
    side = 'top',
    align = 'center',
    class: className = '',
    customAnchor,
    open,
    disabled = false,
    trigger,
    content,
    children,
  }: Props = $props();

  const provided = tooltipProvided();
  const host = tooltipHost();
</script>

{#snippet defaultTrigger({ props }: { props: Record<string, unknown> })}
  <button
    {...props}
    class={['tooltip-trigger', `tooltip-trigger-${variant}`, className]}
    type="button"
    aria-label={variant === 'icon' ? label || undefined : undefined}
  >
    {@render children?.()}
  </button>
{/snippet}

{#snippet tooltip()}
  <BitsTooltip.Root {open} {disabled}>
    {#if customAnchor === undefined}
      <BitsTooltip.Trigger child={trigger ?? defaultTrigger} />
    {/if}
    <BitsTooltip.Portal>
      <BitsTooltip.Content
        class={multiline ? 'tooltip tooltip-multiline' : 'tooltip'}
        {side}
        {align}
        sideOffset={8}
        collisionPadding={collisionPadding()}
        {customAnchor}
      >
        {#if content}{@render content()}{:else}{label}{/if}
      </BitsTooltip.Content>
    </BitsTooltip.Portal>
  </BitsTooltip.Root>
{/snippet}

{#if host && open === undefined && customAnchor === undefined}
  <!-- A tethered trigger's `disabled` disables the element itself, not only its tooltip. -->
  {#if disabled}
    {@render (trigger ?? defaultTrigger)({ props: {} })}
  {:else}
    <BitsTooltip.Trigger
      tether={host}
      payload={{ label, multiline, side, align, content }}
      child={trigger ?? defaultTrigger}
    />
  {/if}
{:else if provided}
  {@render tooltip()}
{:else}
  <TooltipProvider>{@render tooltip()}</TooltipProvider>
{/if}

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
        color var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
