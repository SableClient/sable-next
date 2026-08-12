<script lang="ts">
  import type { Snippet } from 'svelte';
  import MobileNavDrawer from '$lib/ui/MobileNavDrawer.svelte';
  import SidebarNav from '$lib/features/sidebar/SidebarNav.svelte';
  import DeviceVerificationDialog from '$lib/features/settings/DeviceVerificationDialog.svelte';
  import { BREAKPOINTS } from './breakpoints';
  import { createMediaQuery } from './media-query.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  let roomNavWidth = $state(224);
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let mobile = $derived(!appLayout.matches);
</script>

{#if mobile}
  <MobileNavDrawer>
    {@render children()}
  </MobileNavDrawer>
{:else}
  <div class="app-shell" style:--room-nav-width={String(roomNavWidth) + 'px'}>
    <SidebarNav bind:roomNavWidth />
    <div class="app-content">
      {@render children()}
    </div>
  </div>
{/if}

<DeviceVerificationDialog />

<style>
  .app-shell {
    height: 100dvh;
  }

  .app-content {
    background: var(--sable-surface-container);
    box-sizing: border-box;
    display: flex;
    height: 100%;
    min-width: 0;
    overflow: hidden;
  }

  @media (width >= 48rem) {
    .app-content {
      margin-left: calc(4.125rem + var(--room-nav-width));
      padding-bottom: 0;
    }
  }
</style>
