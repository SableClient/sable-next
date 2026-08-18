<script lang="ts">
  import { Switch } from 'bits-ui';

  interface Props {
    checked?: boolean;
    disabled?: boolean;
    label: string;
    onCheckedChange?: (checked: boolean) => void;
  }

  let { checked = $bindable(false), disabled = false, label, onCheckedChange }: Props = $props();
</script>

<Switch.Root bind:checked {disabled} {onCheckedChange} class="sable-switch" aria-label={label}>
  <Switch.Thumb class="sable-switch-thumb" />
</Switch.Root>

<style>
  :global(.sable-switch) {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    height: 1.375rem;
    padding: 2px;
    position: relative;
    width: 2.375rem;
  }

  /* The control reads better at 22px than the 36px touch floor, so the tap
     area is grown separately. */
  :global(.sable-switch::after) {
    content: '';
    inset: -0.4375rem 0;
    position: absolute;
  }

  :global(.sable-switch[data-state='checked']) {
    background: var(--sable-primary-main);
  }

  :global(.sable-switch[data-disabled]) {
    cursor: default;
    opacity: 0.65;
  }

  :global(.sable-switch-thumb) {
    background: var(--sable-bg-container);
    border-radius: var(--radius-pill);
    display: block;
    height: 1rem;
    width: 1rem;
  }

  :global(.sable-switch[data-state='checked'] .sable-switch-thumb) {
    translate: 1rem 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-switch) {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        border-color var(--motion-normal) var(--motion-easing-standard);
    }

    :global(.sable-switch-thumb) {
      transition: translate var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
