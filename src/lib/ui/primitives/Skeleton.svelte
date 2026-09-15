<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'children'>;

  let { class: className = '', ...rest }: Props = $props();
</script>

<span {...rest} class={['skeleton', className]} aria-hidden="true"></span>

<style>
  :global(.skeleton) {
    background: var(--surface-container);
    border-radius: var(--radius);
    display: block;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.skeleton) {
      animation: skeleton-pulse 1.8s ease-in-out infinite;
    }
  }
</style>
