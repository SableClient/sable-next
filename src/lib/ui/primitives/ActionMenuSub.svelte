<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import type { Snippet } from 'svelte';

  import { i18n } from '#lib/i18n.js';

  import BottomSheet from './BottomSheet.svelte';
  import { setActionMenuSurface, useActionMenuSurface } from './action-menu.js';

  interface Props {
    label: string;
    class?: string;
    trigger: Snippet;
    children: Snippet;
  }

  let { label, class: surfaceClass, trigger, children }: Props = $props();

  const parent = useActionMenuSurface();
  let open = $state(false);

  setActionMenuSurface({
    get sheet() {
      return parent.sheet;
    },
    close: () => {
      open = false;
      parent.close();
    },
  });
</script>

{#if parent.sheet}
  <button
    type="button"
    role="menuitem"
    class="menu-item menu-item-roomy action-menu-row"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => {
      open = true;
    }}
  >
    {@render trigger()}
    <CaretRightIcon class="menu-submenu-chevron" aria-hidden="true" />
  </button>
  {#if open}
    <BottomSheet bind:open {label} closeLabel={$i18n.t('timeline.closeMenu')}>
      <div class="action-menu-rows" role="menu">{@render children()}</div>
    </BottomSheet>
  {/if}
{:else}
  <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger class="menu-item">
      {@render trigger()}
      <CaretRightIcon class="menu-submenu-chevron" aria-hidden="true" />
    </DropdownMenu.SubTrigger>
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent class={['menu-surface', surfaceClass]} sideOffset={4}>
        {@render children()}
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  </DropdownMenu.Sub>
{/if}

<style>
  .action-menu-row {
    --menu-item-padding: var(--space-400);

    border-radius: 0;
    font-size: var(--font-size-body);
  }

  .action-menu-rows {
    display: grid;
  }
</style>
