<script lang="ts">
  import type { Snippet } from 'svelte';
  import AppShell from '$lib/ui/AppShell.svelte';
  import { useCoreClient } from '$lib/core/context';
  import { provideRoomList, RoomList } from '$lib/rooms/room-list.svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();
  const roomList = new RoomList(core);
  provideRoomList(roomList);

  $effect(() => {
    if (core.status === 'signed-out') {
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
{:else if core.status === 'error'}
  <main class="app-status" aria-labelledby="app-status-title">
    <div class="app-status-card" role="alert">
      <h1 id="app-status-title">{$i18n.t('app.unableToStart')}</h1>
      <p>{$i18n.t('app.startFailed')}</p>
      <Button onclick={() => void core.start()}>{$i18n.t('app.tryAgain')}</Button>
    </div>
  </main>
{:else}
  <main class="app-status" aria-labelledby="app-status-title" aria-busy="true">
    <div class="app-status-card" role="status">
      <Spinner />
      <h1 id="app-status-title">{$i18n.t('app.starting')}</h1>
    </div>
  </main>
{/if}

<style>
  .app-status {
    align-items: center;
    background: var(--sable-surface-container);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: 2rem 1.5rem;
  }

  .app-status-card {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-dialog);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 28rem;
    padding: 2rem;
    text-align: center;
    width: 100%;
  }

  .app-status-card h1,
  .app-status-card p {
    margin: 0;
  }

  .app-status-card h1 {
    font-size: var(--font-size-medium);
  }

  .app-status-card p {
    color: var(--sable-surface-var-on-container);
    line-height: var(--line-height-body);
  }

  .app-status-card :global(.sable-button) {
    min-width: 8rem;
  }
</style>
