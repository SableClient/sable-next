<script lang="ts">
  import type { Snippet } from 'svelte';
  import AppShell from '$lib/ui/AppShell.svelte';
  import { useCoreClient } from '$lib/core/context';
  import { provideRoomList, RoomList } from '$lib/rooms/room-list.svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();
  const roomList = new RoomList(core);
  provideRoomList(roomList);

  $effect(() => {
    if (core.status === 'signed-out' || core.status === 'error') {
      void goto(resolve('/login'));
    }
  });

  $effect(() => {
    if (core.status !== 'ready') return;

    void roomList.start();
    return () => {
      roomList.stop();
    };
  });
</script>

{#if core.status === 'ready'}
  <AppShell>
    {@render children()}
  </AppShell>
{/if}
