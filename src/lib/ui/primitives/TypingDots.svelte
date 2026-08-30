<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  type Props = { class?: ClassValue };

  let { class: className = '' }: Props = $props();
</script>

<span class={['sable-typing-dots', className]} aria-hidden="true"><i></i><i></i><i></i></span>

<style>
  :global(.sable-typing-dots) {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--space-050);
  }

  :global(.sable-typing-dots i) {
    background: var(--sable-primary-main);
    border-radius: var(--radii-round);
    height: 0.25rem;
    width: 0.25rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-typing-dots i) {
      animation: typing-dot 1.2s infinite ease-in-out;
    }

    :global(.sable-typing-dots i:nth-child(2)) {
      animation-delay: 0.15s;
    }

    :global(.sable-typing-dots i:nth-child(3)) {
      animation-delay: 0.3s;
    }
  }

  @keyframes typing-dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }

    30% {
      opacity: 1;
      transform: translateY(-0.1875rem);
    }
  }
</style>
