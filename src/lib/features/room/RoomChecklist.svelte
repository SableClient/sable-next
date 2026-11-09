<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { RoomListItemView } from '#src/generated/protocol';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { rootSpaceNames } from '#lib/rooms/spaces.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import '#lib/ui/primitives/menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    class: string;
    rooms: readonly RoomListItemView[];
    selected: string[];
    label: (room: RoomListItemView) => string;
  }

  let { class: className, rooms, selected = $bindable(), label }: Props = $props();
  const roomList = useRoomList();
  let spaceNames = $derived(rootSpaceNames(roomList.rooms));

  function toggle(roomId: string): void {
    selected = selected.includes(roomId)
      ? selected.filter((id) => id !== roomId)
      : [...selected, roomId];
  }
</script>

<ul class={className} {@attach scrollHint}>
  {#each rooms as room (room.room_id)}
    {@const checked = selected.includes(room.room_id)}
    {@const where = [spaceNames.get(room.room_id), room.canonical_alias].filter(Boolean)}
    <li>
      <button
        type="button"
        class="menu-item"
        role="checkbox"
        aria-checked={checked}
        onclick={() => {
          toggle(room.room_id);
        }}
      >
        <Avatar size="small" id={room.room_id} src={room.display_avatar_url} name={label(room)} />
        <span class="name">{label(room)}</span>
        {#if where.length}<span class="alias">{where.join(' · ')}</span>{/if}
        <span class="tick" aria-hidden="true">
          {#if checked}<CheckIcon size={14} weight="bold" />{/if}
        </span>
      </button>
    </li>
  {/each}
</ul>

<style>
  ul {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0;
  }

  ul :global(.menu-item) {
    --menu-item-height: var(--control-height-500);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .alias {
    color: var(--surface-var-on-container);
    flex: 0 1 auto;
    font-size: var(--font-size-small);
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tick {
    align-items: center;
    color: var(--primary-main);
    display: inline-flex;
    flex: none;
    height: 1.125rem;
    justify-content: center;
    width: 1.125rem;
  }
</style>
