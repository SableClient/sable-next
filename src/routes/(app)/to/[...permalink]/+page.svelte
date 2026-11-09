<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { selectNotificationAccount } from '#lib/features/notifications/native-actions.js';
  import UserLinkCard from '#lib/features/profile/UserLinkCard.svelte';
  import { matrixLinkPath, permalinkTarget, type PermalinkTarget } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();

  let unresolved = $state(false);
  let user = $state<string | null>(null);
  let startChat = $state(false);

  const routePrefix = resolve('/(app)/to/[...permalink]', { permalink: '' });

  $effect(() => {
    const uri = page.url.searchParams.get('uri');
    if (uri !== null) {
      const path = matrixLinkPath(uri);
      if (path === null) unresolved = true;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- matrixLinkPath() resolves the route
      else void goto(path, { replace: true });
      return;
    }

    // The still-encoded tail, rather than the rest param: the matrix.to parser
    // does its own decoding.
    const via = new URLSearchParams(
      page.url.searchParams.getAll('via').map((server) => ['via', server])
    );
    const fragment = `${page.url.pathname.slice(routePrefix.length + 1)}${via.size ? `?${via}` : ''}`;
    let active = true;
    unresolved = false;
    user = null;
    startChat = false;

    const notifiedUser = page.url.searchParams.get('user');

    const open = async (): Promise<void> => {
      if (notifiedUser !== null) await selectNotificationAccount(core, notifiedUser);
      if (!active) return;

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
        startChat = page.url.searchParams.get('action') === 'chat';
        user = target.userId;
        return;
      }

      const notified = page.url.searchParams.get('notified');
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- permalinkTarget() resolves the route through roomSectionPath()
      await goto(target.path, { replace: true, state: notified === null ? {} : { notified } });
    };

    void open();

    return () => {
      active = false;
    };
  });
</script>

{#if user !== null}
  <UserLinkCard userId={user} {startChat} />
{:else}
  <main class="permalink" aria-busy={!unresolved}>
    {#if unresolved}
      <p role="alert">{i18n.t('permalink.unresolved')}</p>
    {:else}
      <div role="status">
        <Spinner />
        <p>{i18n.t('permalink.opening')}</p>
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
    padding: var(--space-700) var(--space-600);
  }

  .permalink div {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
  }

  .permalink p {
    color: var(--surface-var-on-container);
    margin: 0;
  }
</style>
