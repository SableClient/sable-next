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
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radii-pill);
    box-shadow: inset 0 0 0 var(--border-width-400) currentcolor;
    box-sizing: border-box;
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    height: 1.5rem;
    opacity: var(--opacity-p300);
    padding: 0;
    position: relative;
    user-select: none;
    width: 2.75rem;
  }

  :global(.sable-switch::after) {
    content: '';
    inset: calc((var(--target-hit) - 1.5rem) / -2) 0;
    position: absolute;
  }

  :global(.sable-switch[data-state='checked']) {
    background: var(--sable-primary-main);
    box-shadow: none;
    color: var(--sable-primary-on-main);
    opacity: var(--opacity-p500);
  }

  :global(.sable-switch:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.sable-switch[data-disabled]) {
    cursor: not-allowed;
    opacity: var(--opacity-disabled);
  }

  :global(.sable-switch-thumb) {
    background: currentcolor;
    border-radius: var(--radii-pill);
    display: block;
    height: 0.875rem;
    translate: 0.3125rem 0;
    width: 0.875rem;
  }

  :global(.sable-switch[data-state='checked'] .sable-switch-thumb) {
    height: 1.125rem;
    translate: 1.4375rem 0;
    width: 1.125rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-switch) {
      transition:
        background-color var(--motion-normal) var(--motion-easing-standard),
        box-shadow var(--motion-normal) var(--motion-easing-standard),
        opacity var(--motion-normal) var(--motion-easing-standard);
    }

    :global(.sable-switch-thumb) {
      transition:
        translate var(--motion-normal) var(--motion-easing-standard),
        height var(--motion-normal) var(--motion-easing-standard),
        width var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
