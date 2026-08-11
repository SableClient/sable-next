<script lang="ts">
  interface Props {
    small?: boolean;
  }

  let { small = false }: Props = $props();
</script>

<span class="spinner" class:small aria-hidden="true"></span>

<style>
  .spinner {
    border: 2px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    border-right-color: var(--sable-primary-main);
    height: 1.25rem;
    width: 1.25rem;
  }

  .spinner.small {
    height: 1rem;
    width: 1rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .spinner {
      animation: spin 0.8s linear infinite;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
