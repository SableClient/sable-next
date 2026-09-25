<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';

  import { useActionMenuSurface } from './action-menu.js';

  interface Props {
    class?: ClassValue;
    disabled?: boolean;
    destructive?: boolean;
    checked?: boolean;
    closeOnSelect?: boolean;
    onSelect: () => void;
    children: Snippet;
  }

  let {
    class: extra,
    disabled = false,
    destructive = false,
    checked,
    closeOnSelect = true,
    onSelect,
    children,
  }: Props = $props();

  const surface = useActionMenuSurface();
  let classes = $derived([
    'menu-item',
    destructive && 'menu-item-destructive',
    surface.sheet && 'menu-item-roomy action-menu-row',
    extra,
  ]);

  function select(): void {
    if (!surface.sheet || !closeOnSelect) {
      onSelect();
      return;
    }
    surface.close();
    void afterOverlayPops().then(onSelect);
  }
</script>

{#if surface.sheet}
  <button
    type="button"
    role={checked === undefined ? 'menuitem' : 'menuitemradio'}
    class={classes}
    {disabled}
    aria-checked={checked}
    onclick={select}
  >
    {@render children()}
  </button>
{:else}
  <DropdownMenu.Item
    class={classes}
    {disabled}
    {closeOnSelect}
    aria-checked={checked}
    onSelect={select}
  >
    {@render children()}
  </DropdownMenu.Item>
{/if}

<style>
  .action-menu-row {
    --menu-item-height: max(var(--control-height-400), var(--target-hit));
    --menu-item-padding: var(--space-400);

    border-radius: 0;
    font-size: var(--font-size-label);
  }
</style>
