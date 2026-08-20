<script lang="ts">
  import type { Snippet } from 'svelte';
  import MobileNavDrawer from '#lib/ui/MobileNavDrawer.svelte';
  import SidebarNav from '#lib/features/sidebar/SidebarNav.svelte';
  import DeviceVerificationDialog from '#lib/features/settings/DeviceVerificationDialog.svelte';
  import { BREAKPOINTS } from './breakpoints';
  import { createMediaQuery } from './media-query.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  let roomNavWidth = $state(224);
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
</script>

<div class="app-shell" style:--room-nav-width={String(roomNavWidth) + 'px'}>
  <div class="desktop-navigation" inert={!appLayout.matches}>
    <SidebarNav bind:roomNavWidth />
  </div>
  <MobileNavDrawer>
    {@render children()}
  </MobileNavDrawer>
</div>

<DeviceVerificationDialog />

<style>
  .app-shell {
    height: 100%;
  }

  .desktop-navigation {
    display: none;
  }

  @media (width >= 48rem) {
    .desktop-navigation {
      display: contents;
    }
  }
</style>
