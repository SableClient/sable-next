<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import { i18n } from '$lib/i18n';
  import { permalinkPath } from '$lib/rooms/permalink';
  import { useRoomList } from '$lib/rooms/room-list.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  const roomList = useRoomList();

  let unresolved = $state(false);

  $effect(() => {
    // The still-encoded tail, rather than the rest param: the matrix.to parser
    // does its own decoding.
    const fragment = page.url.pathname.slice('/to/'.length);

    void (async () => {
      // A permalink opened from a notification can beat the room list, without
      // which the room's section cannot be decided.
      await roomList.start();

      const target = permalinkPath(roomList.rooms, fragment);
      if (target === null) {
        unresolved = true;
        return;
      }

      // eslint-disable-next-line svelte/no-navigation-without-resolve -- permalinkPath resolves the route
      await goto(target, { replaceState: true });
    })();
  });
</script>

<main class="permalink" aria-busy={!unresolved}>
  {#if unresolved}
    <p role="alert">{$i18n.t('permalink.unresolved')}</p>
  {:else}
    <div role="status">
      <Spinner />
      <p>{$i18n.t('permalink.opening')}</p>
    </div>
  {/if}
</main>

<style>
  .permalink {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100%;
    padding: 2rem 1.5rem;
  }

  .permalink div {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .permalink p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }
</style>
