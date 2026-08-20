<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { i18n } from '#lib/i18n.js';
  import UserLinkCard from '#lib/features/profile/UserLinkCard.svelte';
  import { permalinkTarget, type PermalinkTarget } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  const roomList = useRoomList();

  let unresolved = $state(false);
  let user = $state<string | null>(null);

  const routePrefix = resolve('/(app)/to/[...permalink]', { permalink: '' });

  $effect(() => {
    // The still-encoded tail, rather than the rest param: the matrix.to parser
    // does its own decoding.
    const fragment = page.url.pathname.slice(routePrefix.length + 1);
    let active = true;
    unresolved = false;
    user = null;

    const open = async (): Promise<void> => {
      // A permalink opened from a notification can beat the room list, without
      // which the room's section cannot be decided.
      await roomList.start();
      if (!active) return;

      const target: PermalinkTarget | null = permalinkTarget(roomList.rooms, fragment);
      if (target === null) {
        unresolved = true;
        return;
      }

      // A user has no route of its own, so the link opens a card here instead.
      if (target.kind === 'user') {
        user = target.userId;
        return;
      }

      await goto(target.path, { replaceState: true });
    };

    void open();

    return () => {
      active = false;
    };
  });
</script>

{#if user !== null}
  <UserLinkCard userId={user} />
{:else}
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
{/if}

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
