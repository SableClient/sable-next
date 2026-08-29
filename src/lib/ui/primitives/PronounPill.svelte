<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'children'> & {
    class?: ClassValue;
    children?: Snippet;
  };

  let { class: className = '', children, ...rest }: Props = $props();
</script>

<span {...rest} class={['sable-pronoun-pill', className]}>{@render children?.()}</span>

<style>
  :global(.sable-pronoun-pill) {
    align-items: center;
    background: color-mix(in oklab, currentcolor 10%, transparent);
    border: var(--border-width) solid color-mix(in oklab, currentcolor 20%, transparent);
    border-radius: var(--radii-pill);
    box-sizing: border-box;
    display: inline-flex;
    font-size: calc(var(--font-size-small) * 0.8);
    font-weight: var(--font-weight-medium);
    justify-content: center;
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 0.125rem var(--space-1);
    text-transform: lowercase;
    white-space: nowrap;
  }
</style>
