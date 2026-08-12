<script lang="ts">
  import { Tooltip as BitsTooltip } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    class?: ClassValue;
    children: Snippet;
  }

  let { label, class: className = '', children }: Props = $props();
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
  <button {...props} class={['tooltip-trigger', className]} type="button" aria-label={label}>
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

  .tooltip-trigger:hover,
  .tooltip-trigger[data-state='open'] {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .tooltip-trigger:focus-visible {
    box-shadow: 0 0 0 0.2rem var(--sable-focus-ring);
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
