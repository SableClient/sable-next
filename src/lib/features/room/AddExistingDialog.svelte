<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import type { RoomSummary } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/menu.css';

  import { addableChildren, type AddExistingKind } from './add-existing';

  interface Props {
    open?: boolean;
    space: RoomSummary;
    kind: AddExistingKind;
    onAdd: (roomIds: string[], suggested: boolean) => void;
  }

  let { open = $bindable(false), space, kind, onAdd }: Props = $props();
  const roomList = useRoomList();
  const fieldId = $props.id();
  let search = $state('');
  let selected = $state<string[]>([]);
  let suggested = $state(false);

  let title = $derived(
    $i18n.t(kind === 'spaces' ? 'room.lobbyAddExistingSpaces' : 'room.lobbyAddExistingRooms')
  );
  let candidates = $derived(addableChildren(roomList.rooms, space, kind, search));

  function toggle(roomId: string): void {
    selected = selected.includes(roomId)
      ? selected.filter((id) => id !== roomId)
      : [...selected, roomId];
  }

  function reset(): void {
    open = false;
    search = '';
    selected = [];
    suggested = false;
  }

  function add(): void {
    if (selected.length === 0) return;
    const rooms = selected;
    const asSuggested = suggested;
    reset();
    onAdd(rooms, asSuggested);
  }
</script>

<DialogFrame bind:open variant="verification" label={title}>
  <div class="add-existing">
    <h2>{title}</h2>
    <TextInput
      id={fieldId}
      bind:value={search}
      placeholder={$i18n.t('room.lobbyAddSearch')}
      aria-label={$i18n.t('room.lobbyAddSearch')}
    />
    {#if candidates.length === 0}
      <p class="empty">
        {search.trim() === '' ? $i18n.t('room.lobbyAddNothing') : $i18n.t('room.lobbyAddNoMatch')}
      </p>
    {:else}
      <ul class="candidates">
        {#each candidates as room (room.room_id)}
          {@const checked = selected.includes(room.room_id)}
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
              <Avatar size="small" id={room.room_id} src={room.avatar_url} name={room.name} />
              <span class="name">{room.name ?? room.canonical_alias ?? room.room_id}</span>
              <span class="tick" aria-hidden="true">
                {#if checked}<CheckIcon size={14} weight="bold" />{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="suggested">
      <span>{$i18n.t('room.lobbyAddSuggested')}</span>
      <Switch bind:checked={suggested} label={$i18n.t('room.lobbyAddSuggested')} />
    </div>

    <div class="actions">
      <Button variant="ghost" onclick={reset}>{$i18n.t('room.lobbyAddCancel')}</Button>
      <Button disabled={selected.length === 0} onclick={add}>
        {selected.length === 0
          ? $i18n.t('room.lobbyAdd')
          : $i18n.t(
              kind === 'spaces' ? 'room.lobbyAddSpacesConfirm' : 'room.lobbyAddRoomsConfirm',
              {
                count: selected.length,
              }
            )}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .add-existing {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .candidates {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0;
  }

  .candidates :global(.menu-item) {
    --menu-item-height: var(--control-height-500);
  }

  .name {
    flex: 1;
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

  .empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .suggested {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
