<script lang="ts">
  import { goto } from '$app/navigation';

  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import RoomJumpList from './RoomJumpList.svelte';
  import { shortcutsHelpState } from './palette-state.svelte.js';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  const roomList = useRoomList();

  function select(room: RoomSummary): void {
    open = false;
    void goto(roomSectionPath(roomList.rooms, room.room_id));
  }

  function openShortcutsHelp(): void {
    open = false;
    shortcutsHelpState.open = true;
  }
</script>

<DialogFrame bind:open variant="sheet" label={$i18n.t('shortcuts.paletteTitle')}>
  <div class="palette">
    <h2>{$i18n.t('shortcuts.paletteTitle')}</h2>
    <RoomJumpList onSelect={select} onClose={() => (open = false)} />
    <footer>
      <Button variant="ghost" size="small" onclick={openShortcutsHelp}>
        {$i18n.t('shortcuts.showShortcuts')}
      </Button>
    </footer>
  </div>
</DialogFrame>

<style>
  .palette {
    display: grid;
    gap: var(--space-300);
    max-width: 34rem;
    width: 100%;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
    padding: var(--space-400) var(--space-400) 0;
  }

  footer {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
    display: flex;
    justify-content: flex-end;
    padding: var(--space-300) var(--space-400);
  }
</style>
