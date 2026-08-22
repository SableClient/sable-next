<script lang="ts">
  interface Props {
    label: string | null;
  }

  let { label }: Props = $props();
</script>

<div class="typing" aria-live="polite" role="status">
  {#if label}
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="label">{label}</span>
  {/if}
</div>

<style>
  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    line-height: 1.125rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .dots {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 0.1875rem;
  }

  .dots i {
    background: var(--sable-primary-main);
    border-radius: 50%;
    height: 0.25rem;
    width: 0.25rem;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (prefers-reduced-motion: no-preference) {
    .dots i {
      animation: typing-dot 1.2s infinite ease-in-out;
    }

    .dots i:nth-child(2) {
      animation-delay: 0.15s;
    }

    .dots i:nth-child(3) {
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
