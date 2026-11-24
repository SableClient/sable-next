<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  interface Props {
    room: RoomListItemView | null;
    canEdit: boolean;
    disabled?: boolean;
  }

  let { room, canEdit, disabled = false }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  let spaceId = $derived(room?.room_kind === 'space' ? room.room_id : null);
  let childIds = $derived(spaceId ? (roomList.roomSpaces(spaceId)?.descendants ?? []) : []);
  let confirming = $state(false);
  let syncing = $state(false);
  let result = $state<{ updated: number; skipped: number } | null>(null);

  async function apply(): Promise<void> {
    if (!spaceId || !canEdit || disabled || syncing || childIds.length === 0) return;

    const targets = childIds;
    syncing = true;
    try {
      result = await core.rpc.members.syncChildPowerLevels({
        space_id: spaceId,
        child_ids: targets,
      });
    } catch (error) {
      console.warn('[sable room] child permission sync failed', error);
      result = { updated: 0, skipped: targets.length };
    } finally {
      syncing = false;
      confirming = false;
    }
  }
</script>

{#if canEdit && childIds.length > 0}
  <SettingsSection headingId="room-perm-children" title={i18n.t('room.permChildrenTitle')}>
    <ul class="settings-rows">
      <SettingsRow
        title={i18n.t('room.permChildrenRow', { count: childIds.length })}
        description={result
          ? i18n.t('room.permChildrenDone', { count: result.updated, skipped: result.skipped })
          : i18n.t('room.permChildrenHint')}
      >
        <Button
          variant="secondary"
          disabled={disabled || syncing}
          onclick={() => {
            result = null;
            confirming = true;
          }}
        >
          {i18n.t('room.permChildrenAction')}
        </Button>
      </SettingsRow>
    </ul>
  </SettingsSection>

  <ConfirmDialog
    bind:open={confirming}
    title={i18n.t('room.permChildrenConfirm', { count: childIds.length })}
    description={i18n.t('room.permChildrenConfirmHint')}
    confirmLabel={i18n.t('common.apply')}
    confirmDisabled={disabled}
    busy={syncing}
    onConfirm={() => void apply()}
  />
{/if}
