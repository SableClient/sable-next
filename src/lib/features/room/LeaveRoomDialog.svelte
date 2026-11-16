<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { spaceLeaveOrder } from '#lib/model/model.js';

  interface Props {
    open: boolean;
    room: RoomListItemView | null;
    onOpenChange: (open: boolean) => void;
    onLeft?: (room: RoomListItemView) => void;
  }

  let { open, room, onOpenChange, onLeft }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  let leaving = $state(false);
  let failedNames = $state.raw<string[]>([]);

  let children = $derived(
    room?.room_kind === 'space' ? spaceLeaveOrder(roomList.rooms, room.room_id) : null
  );

  let childrenWarning = $derived.by(() => {
    if (!children || children.order.length === 0) return null;

    const rooms =
      children.room_count > 0
        ? i18n.t('room.leaveSpaceChildrenRoomsCount', { count: children.room_count })
        : null;
    const subspaces =
      children.subspace_count > 0
        ? i18n.t('room.leaveSpaceChildrenSubspacesCount', { count: children.subspace_count })
        : null;

    if (rooms && subspaces) {
      return i18n.t('room.leaveSpaceChildrenWarningBoth', { rooms, subspaces });
    }
    if (rooms) return i18n.t('room.leaveSpaceChildrenWarningRooms', { rooms });
    return i18n.t('room.leaveSpaceChildrenWarningSubspaces', { subspaces });
  });

  async function leaveIds(ids: readonly string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await core.rpc.rooms.leave({ room_id: id });
      } catch (error) {
        console.warn('[sable room] leave failed', error);
        failures.push(roomList.labelFor(id));
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
    const order = [...spaceLeaveOrder(roomList.rooms, target.room_id).order, target.room_id];
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

<DialogFrame {open} {onOpenChange} variant="verification" label={i18n.t('room.leaveConfirm')}>
  <div class="leave">
    <h2>{i18n.t('room.leaveTitle', { name: room?.name ?? room?.room_id ?? '' })}</h2>
    <p class="explain">{i18n.t('room.leaveBody')}</p>
    {#if childrenWarning}
      <p class="explain">{childrenWarning}</p>
    {/if}
    {#if failedNames.length > 0}
      <Alert variant="critical" role="alert">
        {i18n.t('room.leaveFailedNames', { names: failedNames.join(', ') })}
      </Alert>
    {/if}
    <DialogActions>
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {i18n.t('common.cancel')}
      </Button>
      {#if children && children.order.length > 0}
        <Button variant="danger" loading={leaving} onclick={confirmAll}>
          {i18n.t('room.leaveAllConfirm')}
        </Button>
      {/if}
      <Button variant="danger" loading={leaving} onclick={confirm}>
        {i18n.t('room.leaveConfirm')}
      </Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .leave {
    display: grid;
    gap: var(--space-400);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
