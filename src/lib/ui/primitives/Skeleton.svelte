<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'children'>;

  let { class: className = '', ...rest }: Props = $props();
</script>

<span {...rest} class={['sable-skeleton', className]} aria-hidden="true"></span>

<style>
  :global(.sable-skeleton) {
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    display: block;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-skeleton) {
      animation: skeleton-pulse 1.8s ease-in-out infinite;
    }
  }

  @keyframes skeleton-pulse {
    50% {
      opacity: 0.55;
    }
  }
</style>
