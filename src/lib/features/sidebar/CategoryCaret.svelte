<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';

  interface Props {
    closed: boolean;
  }

  let { closed }: Props = $props();
</script>

<span class={['category-caret', { closed }]} aria-hidden="true"><CaretDownIcon /></span>

<style>
  .category-caret {
    align-items: center;
    display: inline-flex;
    flex: 0 0 var(--icon-size-large);
    height: var(--icon-size-large);
    justify-content: center;
    line-height: 0;
    width: var(--icon-size-large);
  }

  @media (prefers-reduced-motion: no-preference) {
    .category-caret {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .category-caret.closed {
    transform: rotate(-90deg);
  }

  .category-caret :global(svg) {
    height: 1rem;
    width: 1rem;
  }
</style>
