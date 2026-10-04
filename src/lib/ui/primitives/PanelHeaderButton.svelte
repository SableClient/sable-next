<script lang="ts">
  import { mergeProps } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import type { ButtonProps } from './button-types';

  type Props = Omit<ButtonProps, 'children' | 'class' | 'size' | 'variant'> & {
    label: string;
    class?: ClassValue;
    children?: Snippet;
  };

  let { label, class: className = '', children, ...rest }: Props = $props();

  let pressed = $derived(rest['aria-pressed']);
  let toggle = $derived(typeof pressed === 'boolean');

  function triggerProps(tooltipProps: Record<string, unknown>): Record<string, unknown> {
    const { 'data-state': tooltipState, ...merged } = mergeProps(tooltipProps, rest);
    return 'data-state' in rest ? { ...merged, 'data-state': tooltipState } : merged;
  }
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
  <IconButton
    {...triggerProps(props)}
    {...toggle ? { 'data-state': pressed ? 'open' : 'closed' } : {}}
    {label}
    size="small"
    variant="ghost"
    class={['panel-header-button', toggle && 'selection-open', className]}
  >
    {@render children?.()}
  </IconButton>
{/snippet}

<Tooltip {label} {trigger} />

<style>
  @media (width < 48rem), (pointer: coarse) {
    :global(.panel-header-button) {
      --button-height: var(--control-height-touch);
    }
  }
</style>
