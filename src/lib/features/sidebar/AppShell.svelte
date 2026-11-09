<script lang="ts">
  import type { Snippet } from 'svelte';
  import MobileNavDrawer from '#lib/features/sidebar/MobileNavDrawer.svelte';
  import SidebarNav from '#lib/features/sidebar/SidebarNav.svelte';
  import DeviceVerificationDialog from '#lib/features/settings/DeviceVerificationDialog.svelte';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { ALERT_MODULES, provideAlertProviders } from './alerts';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  let roomNavWidth = $state(288);
  const appLayout = new AppLayout();

  const alertProviders = ALERT_MODULES.map((component) => component.priorityProvider());
  provideAlertProviders(alertProviders);
</script>

<div class="app-shell" style:--room-nav-width={String(roomNavWidth) + 'px'}>
  {#if appLayout.current}
    <div class="desktop-navigation">
      <SidebarNav bind:roomNavWidth />
    </div>
  {/if}
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

  @media (--app-layout) {
    .desktop-navigation {
      display: contents;
    }
  }
</style>
