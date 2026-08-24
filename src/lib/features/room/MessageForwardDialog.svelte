<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/menu.css';

  interface Props {
    open?: boolean;
    fromRoomId: string;
    onForward: (toRoomId: string) => void;
  }

  let { open = $bindable(false), fromRoomId, onForward }: Props = $props();
  const roomList = useRoomList();
  let search = $state('');
  const fieldId = $props.id();

  let targets = $derived(
    roomList.rooms
      .filter((room) => room.state === 'joined' && !room.is_space && room.room_id !== fromRoomId)
      .filter((room) =>
        (room.name ?? room.room_id).toLowerCase().includes(search.trim().toLowerCase())
      )
  );

  function pick(roomId: string): void {
    open = false;
    search = '';
    onForward(roomId);
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.forwardTitle')}>
  <h2>{$i18n.t('timeline.forwardTitle')}</h2>
  <TextInput
    id={fieldId}
    bind:value={search}
    placeholder={$i18n.t('timeline.forwardSearch')}
    aria-label={$i18n.t('timeline.forwardSearch')}
  />
  {#if targets.length === 0}
    <p class="empty">{$i18n.t('timeline.forwardEmpty')}</p>
  {:else}
    <ul class="targets">
      {#each targets as room (room.room_id)}
        <li>
          <button
            type="button"
            class="sable-menu-item"
            onclick={() => {
              pick(room.room_id);
            }}
          >
            <Avatar size="small" src={room.avatar_url} initials={(room.name ?? '?').slice(0, 1)} />
            <span class="name">{room.name ?? room.room_id}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</DialogFrame>

<style>
  h2 {
    font-size: var(--font-size-h4);
    line-height: var(--line-height-h4);
    margin: 0 0 var(--space-300);
  }

  .targets {
    display: grid;
    list-style: none;
    margin: var(--space-300) 0 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0;
  }

  .targets :global(.sable-menu-item) {
    --menu-item-height: var(--control-height-500);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-t300);
    margin: var(--space-400) 0 0;
  }
</style>
