<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { isRoomId } from '#lib/rooms/meowlnir-config.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import RoomChecklist from '../RoomChecklist.svelte';

  interface Props {
    open?: boolean;
    roomId: string;
    protectedIds: readonly string[];
    onProtect: (roomIds: string[]) => void;
  }

  let { open = $bindable(false), roomId, protectedIds, onProtect }: Props = $props();
  const roomList = useRoomList();
  const fieldId = $props.id();
  let search = $state('');
  let selected = $state.raw<string[]>([]);

  let query = $derived(search.trim().toLowerCase());
  let candidates = $derived(
    roomList.rooms.filter(
      (room) =>
        room.state === 'joined' &&
        room.room_kind !== 'space' &&
        !room.is_direct &&
        room.room_id !== roomId &&
        !protectedIds.includes(room.room_id)
    )
  );
  let matches = $derived(
    candidates.filter((room) =>
      [room.display_name, room.canonical_alias, roomList.roomSpaces(room.room_id)?.root_name].some(
        (text) => text?.toLowerCase().includes(query)
      )
    )
  );
  let typedId = $derived.by(() => {
    const id = search.trim();
    return isRoomId(id) && id !== roomId && !protectedIds.includes(id) ? id : null;
  });

  function close(): void {
    open = false;
    search = '';
    selected = [];
  }

  function protect(roomIds: string[]): void {
    if (roomIds.length === 0) return;
    close();
    onProtect(roomIds);
  }
</script>

<DialogFrame bind:open variant="verification" label={i18n.t('room.moderationProtectTitle')}>
  <div class="protect">
    <h2>{i18n.t('room.moderationProtectTitle')}</h2>
    <TextInput
      id={fieldId}
      bind:value={search}
      placeholder={i18n.t('room.moderationProtectSearch')}
      aria-label={i18n.t('room.moderationProtectSearch')}
      autocapitalize="off"
      autocomplete="off"
      spellcheck={false}
    />
    {#if typedId}
      <Button variant="secondary" onclick={() => protect([...selected, typedId])}>
        {i18n.t('room.moderationProtectId', { id: typedId })}
      </Button>
    {:else if matches.length === 0}
      <p class="empty">{i18n.t('common.noRoomsMatch')}</p>
    {:else}
      <RoomChecklist
        class="targets"
        rooms={matches}
        bind:selected
        label={(room) => room.display_name}
      />
    {/if}
    <div class="actions">
      <Button variant="ghost" onclick={close}>{i18n.t('common.cancel')}</Button>
      <Button disabled={selected.length === 0} onclick={() => protect(selected)}>
        {selected.length === 0
          ? i18n.t('room.moderationProtect')
          : i18n.t('room.moderationProtectSelected', { count: selected.length })}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .protect {
    display: grid;
    gap: var(--space-300);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
