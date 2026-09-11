<script lang="ts">
  import { DropdownMenu } from 'bits-ui';

  import { useActionMenuSurface } from './action-menu.js';

  const surface = useActionMenuSurface();
</script>

{#if surface.sheet}
  <div class="action-menu-line" role="separator"></div>
{:else}
  <DropdownMenu.Separator class="menu-separator" />
{/if}

<style>
  .action-menu-line {
    background: var(--surface-container-line);
    block-size: var(--border-width);
  }
</style>
