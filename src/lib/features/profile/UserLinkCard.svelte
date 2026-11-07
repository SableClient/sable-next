<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';

  import type { ProfileView } from '#src/generated/protocol';

  import { openDirectMessage } from '#lib/core/api/rooms.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { existingChatPath, roomSectionPath } from '#lib/rooms/permalink.js';
  import { hasDirectRoom, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  interface Props {
    userId: string;
    startChat?: boolean;
  }

  let { userId, startChat = false }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();

  let profile = $state.raw<ProfileView | null>(null);
  let loaded = $state(false);
  let opening = $state(false);
  let failed = $state(false);
  let confirming = $state(false);
  let prompted: string | null = null;

  let name = $derived(profile?.display_name ?? userId);
  let avatar_url = $derived(profile?.avatar_url ?? null);

  $effect(() => {
    const wanted = userId;
    let active = true;
    profile = null;
    loaded = false;

    core
      .userProfile(wanted)
      .then((result) => {
        if (active) profile = result;
      })
      .catch((error: unknown) => {
        // A profile is optional decoration; the id is enough to open a chat.
        console.debug('[sable profile] profile unavailable', error);
      })
      .finally(() => {
        if (active) loaded = true;
      });

    return () => {
      active = false;
    };
  });

  $effect(() => {
    // Read only the request here: profile loading and room updates must not repeat it.
    const requestedUser = userId;
    if (!startChat || !roomList.settled || prompted === requestedUser) return;
    prompted = requestedUser;
    untrack(() => {
      const target = existingChatPath(roomList.rooms, requestedUser);
      if (target !== null) {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- existingChatPath resolves the room route
        void goto(target, { replace: true });
      } else {
        confirming = true;
      }
    });
  });

  async function message(): Promise<void> {
    if (opening) return;
    opening = true;
    failed = false;
    try {
      const roomId = await openDirectMessage(core, userId);
      const target = roomSectionPath(roomList.rooms, roomId);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
      await goto(target, { replace: true });
    } catch (error) {
      console.warn('[sable profile] could not open a chat', error);
      failed = true;
    } finally {
      opening = false;
    }
  }

  function requestMessage(): void {
    if (hasDirectRoom(roomList.rooms, userId)) void message();
    else confirming = true;
  }
</script>

<section class="user-link" aria-labelledby="user-link-title">
  {#if !loaded}
    <div role="status"><Spinner /></div>
  {:else}
    <Avatar id={userId} src={avatar_url} openable={true} {name} size="large" />
    <h1 id="user-link-title">{name}</h1>
    <p class="user-link-id">{userId}</p>
    {#if failed}
      <p role="alert">{i18n.t('userLink.failed')}</p>
    {/if}
    <Button onclick={requestMessage} disabled={opening}>
      {opening ? i18n.t('userLink.opening') : i18n.t('userLink.action')}
    </Button>
  {/if}
</section>

<ConfirmDialog
  bind:open={confirming}
  title={i18n.t('direct.confirmTitle', { name })}
  description={i18n.t('direct.confirmBody')}
  confirmLabel={i18n.t('direct.submit')}
  confirmVariant="primary"
  onConfirm={() => {
    confirming = false;
    void message();
  }}
/>

<style>
  .user-link {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    justify-content: center;
    min-height: 100%;
    padding: var(--space-700) var(--space-600);
    text-align: center;
  }

  .user-link h1 {
    font-size: var(--font-size-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .user-link p {
    color: var(--surface-var-on-container);
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
