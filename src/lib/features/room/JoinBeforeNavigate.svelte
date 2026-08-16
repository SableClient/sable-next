<script lang="ts">
  import { goto } from '$app/navigation';

  import type { RoomPreviewView } from '@/generated/RoomPreviewView';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { roomSectionPath } from '$lib/rooms/permalink';
  import { useRoomList } from '$lib/rooms/room-list.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  interface Props {
    roomId: string;
    eventId?: string | null;
    via?: string[];
  }

  let { roomId, eventId = null, via = [] }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();

  let preview = $state<RoomPreviewView | null>(null);
  let failed = $state(false);
  let joining = $state(false);
  let joinFailed = $state(false);

  let title = $derived(preview?.name ?? roomId);
  let initials = $derived(
    (preview?.name ?? roomId)
      .replace(/^[!#@]/, '')
      .slice(0, 1)
      .toUpperCase()
  );

  $effect(() => {
    const address = roomId;
    let active = true;
    preview = null;
    failed = false;

    core
      .roomPreview(address, via)
      .then((result) => {
        if (active) preview = result;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] preview unavailable', error);
        if (active) failed = true;
      });

    return () => {
      active = false;
    };
  });

  async function join(): Promise<void> {
    if (joining) return;
    joining = true;
    joinFailed = false;
    try {
      // The alias resolves on servers that have never seen the room id.
      const joined = await core.joinRoom(preview?.canonical_alias ?? roomId, via);
      const target = roomSectionPath(roomList.rooms, joined, eventId);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath resolves the route
      await goto(target, { replaceState: true });
    } catch (error) {
      console.warn('[sable room] join failed', error);
      joinFailed = true;
    } finally {
      joining = false;
    }
  }
</script>

<section class="join" aria-labelledby="join-title">
  {#if failed}
    <p role="alert">{$i18n.t('join.unavailable', { room: roomId })}</p>
  {:else if preview === null}
    <div role="status"><Spinner /></div>
  {:else}
    <Avatar src={preview.avatar_url} {initials} size="large" shape="room" />
    <h1 id="join-title">{title}</h1>
    {#if preview.canonical_alias}
      <p class="join-address">{preview.canonical_alias}</p>
    {/if}
    <p class="join-members">
      {$i18n.t('join.members', { count: preview.num_joined_members })}
    </p>
    {#if preview.topic}
      <p class="join-topic">{preview.topic}</p>
    {/if}
    {#if joinFailed}
      <p role="alert">{$i18n.t('join.failed')}</p>
    {/if}
    <Button onclick={() => void join()} disabled={joining}>
      {joining ? $i18n.t('join.joining') : $i18n.t('join.action')}
    </Button>
  {/if}
</section>

<style>
  .join {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    justify-content: center;
    min-height: 100%;
    padding: 2rem 1.5rem;
    text-align: center;
  }

  .join h1 {
    font-size: var(--font-size-medium);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .join p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    max-width: 32rem;
  }

  .join-topic {
    line-height: var(--line-height-body);
  }
</style>
