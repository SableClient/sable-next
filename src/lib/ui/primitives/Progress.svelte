<script lang="ts">
  import { Progress } from 'bits-ui';

  interface Props {
    value: number | null;
    label: string;
  }

  let { value, label }: Props = $props();
</script>

<Progress.Root class="progress-track" {value} aria-label={label}>
  <span class="progress-fill" style:scale={value === null ? null : `${value / 100} 1`}></span>
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

  :global(.progress-fill:dir(rtl)) {
    transform-origin: right center;
  }

  :global(.progress-track[data-indeterminate] .progress-fill) {
    opacity: 0.4;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.progress-fill) {
      transition: scale var(--motion-normal) var(--ease-smooth-out);
    }

    :global(
      html:not([data-reduced-motion='on']) .progress-track[data-indeterminate] .progress-fill
    ) {
      animation: progress-indeterminate 1.4s var(--motion-easing-standard) infinite;
      inline-size: 40%;
      opacity: 1;
    }
  }

  @keyframes progress-indeterminate {
    from {
      translate: -100% 0;
    }

    to {
      translate: 250% 0;
    }
  }
</style>
