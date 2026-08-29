<script lang="ts">
  import { goto } from '$app/navigation';

  import type { ProfileView } from '#src/generated/ProfileView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  interface Props {
    userId: string;
  }

  let { userId }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();

  let profile = $state<ProfileView | null>(null);
  let loaded = $state(false);
  let opening = $state(false);
  let failed = $state(false);

  let name = $derived(profile?.display_name ?? userId);

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

  async function message(): Promise<void> {
    if (opening) return;
    opening = true;
    failed = false;
    try {
      const roomId = await core.commands.createDm(userId);
      const target = roomSectionPath(roomList.rooms, roomId);
      await goto(target, { replaceState: true });
    } catch (error) {
      console.warn('[sable profile] could not open a chat', error);
      failed = true;
    } finally {
      opening = false;
    }
  }
</script>

<section class="user-link" aria-labelledby="user-link-title">
  {#if !loaded}
    <div role="status"><Spinner /></div>
  {:else}
    <Avatar src={profile?.avatar_url} {name} size="large" />
    <h1 id="user-link-title">{name}</h1>
    <p class="user-link-id">{userId}</p>
    {#if failed}
      <p role="alert">{$i18n.t('userLink.failed')}</p>
    {/if}
    <Button onclick={() => void message()} disabled={opening}>
      {opening ? $i18n.t('userLink.opening') : $i18n.t('userLink.action')}
    </Button>
  {/if}
</section>

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
    color: var(--sable-surface-var-on-container);
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
