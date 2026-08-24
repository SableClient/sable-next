<script lang="ts">
  import { Progress } from 'bits-ui';

  interface Props {
    value: number;
    label: string;
  }

  let { value, label }: Props = $props();
</script>

<Progress.Root class="sable-progress" {value} aria-label={label} aria-valuetext={label}>
  <span class="sable-progress-fill" style="inline-size: {value}%"></span>
</Progress.Root>

<style>
  :global(.sable-progress) {
    background: var(--sable-surface-var-container);
    block-size: var(--space-1);
    border-radius: var(--radius-pill);
    display: block;
    overflow: hidden;
  }

  :global(.sable-progress-fill) {
    background: var(--sable-primary-main);
    block-size: 100%;
    display: block;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-progress-fill) {
      transition: inline-size var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
