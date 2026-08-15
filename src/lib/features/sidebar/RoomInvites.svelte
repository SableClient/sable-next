<script lang="ts">
  import type { RoomSummary } from '@/generated/RoomSummary';
  import { SvelteSet } from 'svelte/reactivity';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { roomPathParamFromId, useRoomList } from '$lib/rooms/room-list.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import MediaImage from '$lib/ui/MediaImage.svelte';

  interface Props {
    collapsed?: boolean;
  }

  let { collapsed = false }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const answering = new SvelteSet<string>();

  let invites = $derived(roomList.rooms.filter((room) => room.state === 'invited'));

  function initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  async function accept(room: RoomSummary): Promise<void> {
    if (answering.has(room.room_id)) return;
    answering.add(room.room_id);
    try {
      const roomId = await core.joinRoom(room.room_id);
      await goto(
        room.is_space
          ? resolve('/(app)/space/[spaceId]', { spaceId: roomPathParamFromId(roomId) })
          : resolve('/(app)/home/[roomId]', { roomId: roomPathParamFromId(roomId) })
      );
    } catch (error) {
      console.warn('[sable room] accepting the invitation failed', error);
    } finally {
      answering.delete(room.room_id);
    }
  }

  async function decline(room: RoomSummary): Promise<void> {
    if (answering.has(room.room_id)) return;
    answering.add(room.room_id);
    try {
      await core.leaveRoom(room.room_id);
    } catch (error) {
      console.warn('[sable room] declining the invitation failed', error);
    } finally {
      answering.delete(room.room_id);
    }
  }
</script>

{#if invites.length > 0 && !collapsed}
  <section class="invites" aria-label={$i18n.t('room.invitesTitle')}>
    <h3>{$i18n.t('room.invitesTitle')}</h3>
    <ul>
      {#each invites as invite (invite.room_id)}
        {@const name = invite.name ?? invite.room_id}
        {@const busy = answering.has(invite.room_id)}
        <li>
          <span class="invite-icon" aria-hidden="true">
            {#if invite.avatar_url}
              <MediaImage
                source={invite.avatar_url}
                alt=""
                width={56}
                height={56}
                class="room-image"
              />
            {:else}
              {initial(name)}
            {/if}
          </span>
          <span class="invite-name" title={name}>{name}</span>
          <IconButton
            variant="ghost"
            size="small"
            disabled={busy}
            label={$i18n.t('room.inviteAccept')}
            onclick={() => {
              void accept(invite);
            }}
          >
            <CheckIcon />
          </IconButton>
          <IconButton
            variant="ghost"
            size="small"
            disabled={busy}
            label={$i18n.t('room.inviteDecline')}
            onclick={() => {
              void decline(invite);
            }}
          >
            <XIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .invites {
    padding: 0 0.5rem 0.5rem;
  }

  h3 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0 0.5rem;
    text-transform: uppercase;
  }

  ul {
    display: grid;
    gap: 0.25rem;
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
  }

  li {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-1);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 0.25rem 0 0.5rem;
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  .invite-icon {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.75rem;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.75rem;
    justify-content: center;
    overflow: hidden;
    width: 1.75rem;
  }

  .invite-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
