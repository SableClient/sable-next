<script lang="ts">
  import { goto } from '$app/navigation';

  import type { RoomListItemView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
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

  function select(room: RoomListItemView): void {
    open = false;
    const target = roomSectionPath(roomList.rooms, room.room_id);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void afterOverlayPops().then(() => goto(target));
  }

  function openShortcutsHelp(): void {
    open = false;
    shortcutsHelpState.open = true;
  }
</script>

<DialogFrame bind:open variant="verification" label={i18n.t('shortcuts.paletteTitle')}>
  <div class="palette">
    <RoomJumpList onSelect={select} onClose={() => (open = false)} />
    <footer>
      <Button variant="ghost" size="small" onclick={openShortcutsHelp}>
        {i18n.t('shortcuts.showShortcuts')}
      </Button>
    </footer>
  </div>
</DialogFrame>

<style>
  .palette {
    display: grid;
    gap: var(--space-300);
    width: min(34rem, calc(100vw - 2rem));
  }

  footer {
    border-top: var(--border-width) solid var(--bg-container-line);
    display: flex;
    justify-content: flex-end;
    padding-top: var(--space-200);
  }
</style>
