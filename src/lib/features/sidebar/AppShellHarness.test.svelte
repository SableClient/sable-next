<script lang="ts">
  import { untrack } from 'svelte';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { FakeRuntime, roomsView } from '#lib/test-support/fake-runtime.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import { provideAlertProviders } from './alerts.js';
  import AppShell from './AppShell.svelte';

  const fakeRuntime = new FakeRuntime({ rooms: roomsView([]) });
  provideRoomList(untrack(() => new RoomList(() => fakeRuntime.client())));
  provideAlertProviders([]);
</script>

<div class="viewport">
  <TooltipProvider>
    <AppShell><button type="button">Page content</button></AppShell>
  </TooltipProvider>
</div>

<style>
  .viewport {
    inset: 0;
    position: fixed;
  }
</style>
