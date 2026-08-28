<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { joinedSpaceChildrenLeaveOrder, recursiveSpaceLeaveOrder } from './space-leave-order.js';

  interface Props {
    open: boolean;
    room: RoomSummary | null;
    onOpenChange: (open: boolean) => void;
    onLeft?: (room: RoomSummary) => void;
  }

  let { open, room, onOpenChange, onLeft }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  let leaving = $state(false);
  let failedNames = $state<string[]>([]);

  let children = $derived(
    room?.is_space ? joinedSpaceChildrenLeaveOrder(roomList.rooms, room.room_id) : null
  );

  let childrenWarning = $derived.by(() => {
    if (!children || children.order.length === 0) return null;

    const rooms =
      children.roomCount > 0
        ? $i18n.t('room.leaveSpaceChildrenRoomsCount', { count: children.roomCount })
        : null;
    const subspaces =
      children.subspaceCount > 0
        ? $i18n.t('room.leaveSpaceChildrenSubspacesCount', { count: children.subspaceCount })
        : null;

    if (rooms && subspaces) {
      return $i18n.t('room.leaveSpaceChildrenWarningBoth', { rooms, subspaces });
    }
    if (rooms) return $i18n.t('room.leaveSpaceChildrenWarningRooms', { rooms });
    return $i18n.t('room.leaveSpaceChildrenWarningSubspaces', { subspaces });
  });

  function roomName(roomId: string): string {
    return roomList.rooms.find((candidate) => candidate.room_id === roomId)?.name ?? roomId;
  }

  async function leaveIds(ids: readonly string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await core.commands.leaveRoom(id);
      } catch (error) {
        console.warn('[sable room] leave failed', error);
        failures.push(roomName(id));
      }
    }
    return failures;
  }

  async function confirm(): Promise<void> {
    const target = room;
    if (!target || leaving) return;

    leaving = true;
    failedNames = [];
    const failures = await leaveIds([target.room_id]);
    leaving = false;
    if (failures.length > 0) {
      failedNames = failures;
      return;
    }
    onOpenChange(false);
    onLeft?.(target);
  }

  async function confirmAll(): Promise<void> {
    const target = room;
    if (!target || leaving) return;

    leaving = true;
    failedNames = [];
    const order = recursiveSpaceLeaveOrder(roomList.rooms, target.room_id);
    const failures = await leaveIds(order);
    leaving = false;
    if (failures.length > 0) {
      failedNames = failures;
      return;
    }
    onOpenChange(false);
    onLeft?.(target);
  }
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.leaveConfirm')}>
  <div class="leave">
    <h2>{$i18n.t('room.leaveTitle', { name: room?.name ?? room?.room_id ?? '' })}</h2>
    <p class="explain">{$i18n.t('room.leaveBody')}</p>
    {#if childrenWarning}
      <p class="explain">{childrenWarning}</p>
    {/if}
    {#if failedNames.length > 0}
      <Alert variant="critical" role="alert">
        {$i18n.t('room.leaveFailedNames', { names: failedNames.join(', ') })}
      </Alert>
    {/if}
    <div class="actions">
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {$i18n.t('room.leaveCancel')}
      </Button>
      {#if children && children.order.length > 0}
        <Button variant="danger" loading={leaving} onclick={confirmAll}>
          {$i18n.t('room.leaveAllConfirm')}
        </Button>
      {/if}
      <Button variant="danger" loading={leaving} onclick={confirm}>
        {$i18n.t('room.leaveConfirm')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .leave {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
</style>
