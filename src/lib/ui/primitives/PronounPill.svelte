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
    background: var(--sable-surface-var-container);
    border-radius: var(--radii-pill);
    font-size: 0.7rem;
    opacity: var(--opacity-p400);
    padding-inline: var(--space-200);
    text-transform: lowercase;
    white-space: nowrap;
  }
</style>
