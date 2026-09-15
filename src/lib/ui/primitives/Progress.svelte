<script lang="ts">
  import { Progress } from 'bits-ui';

  interface Props {
    value: number;
    label: string;
  }

  let { value, label }: Props = $props();
</script>

<Progress.Root class="progress-track" {value} aria-label={label} aria-valuetext={label}>
  <span class="progress-fill" style="scale: {value / 100} 1;"></span>
</Progress.Root>

<style>
  :global(.progress-track) {
    background: var(--primary-container);
    block-size: var(--space-300);
    border-radius: var(--radii-pill);
    display: flex;
    overflow: hidden;
  }

  :global(.progress-fill) {
    background: var(--primary-main);
    block-size: 100%;
    display: inline-block;
    inline-size: 100%;
    transform-origin: left center;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.progress-fill) {
      transition: scale var(--motion-normal) var(--ease-smooth-out);
    }
  }
</style>
