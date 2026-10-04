<script lang="ts">
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';

  import type { RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  interface Props {
    collapsed?: boolean;
  }

  let { collapsed = false }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const headingId = $props.id();

  let replaced = $state.raw<RoomSummary[]>([]);
  let listedCount = $derived(roomList.rooms.length);

  $effect(() => {
    void listedCount;
    void core.commands.replacedRooms().then((rooms) => {
      replaced = rooms;
    });
  });

  async function leave(room: RoomSummary): Promise<void> {
    try {
      await core.commands.leaveRoom(room.room_id);
      replaced = replaced.filter((other) => other.room_id !== room.room_id);
    } catch {
      toasts.error($i18n.t('room.leaveFailed'));
    }
  }
</script>

{#if replaced.length > 0 && collapsed}
  <ul class="replaced-collapsed" aria-label={$i18n.t('room.replacedTitle')}>
    {#each replaced as room (room.room_id)}
      {@const name = room.name ?? room.room_id}
      <li title={name} aria-label={name}>
        <Avatar class="replaced-icon" id={room.room_id} src={room.avatar_url} {name} />
      </li>
    {/each}
  </ul>
{:else if replaced.length > 0}
  <section class="replaced" aria-labelledby={headingId}>
    <h3 id={headingId}>
      {$i18n.t('room.replacedTitle')}
      <span class="count">{replaced.length}</span>
    </h3>
    <ul>
      {#each replaced as room (room.room_id)}
        {@const name = room.name ?? room.room_id}
        <li>
          <Avatar class="replaced-icon" id={room.room_id} src={room.avatar_url} {name} />
          <span class="replaced-name" title={name}>{name}</span>
          <IconButton
            variant="ghost"
            size="medium"
            label={$i18n.t('room.replacedLeaveLabel', { room: name })}
            onclick={() => {
              void leave(room);
            }}
          >
            <SignOutIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .replaced {
    padding: 0 var(--space-200) var(--space-200);
  }

  h3 {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    margin: 0;
    padding: 0 var(--space-200);
    text-transform: uppercase;
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  ul {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: var(--space-100) 0 0;
    padding: 0;
  }

  li {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-200);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 var(--space-100) 0 var(--space-200);
  }

  li:hover {
    background: var(--bg-container-hover);
  }

  .replaced-collapsed {
    display: grid;
    gap: var(--space-100);
    justify-items: center;
    list-style: none;
    margin: 0;
    padding: 0 0 var(--space-200);
  }

  .replaced-collapsed li {
    padding: 0;
  }

  :global(.avatar-root.replaced-icon) {
    --avatar-size: 1.75rem;

    font-size: var(--font-size-small);
  }

  .replaced-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
