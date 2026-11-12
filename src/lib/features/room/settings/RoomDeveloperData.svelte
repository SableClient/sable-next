<script lang="ts">
  import { Copied } from '#lib/ui/copied.svelte.js';
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomListItemView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { saveBytes } from '#lib/platform/files.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import { collectRoomDebugData } from './room-debug-data.js';

  let {
    room,
    permissions,
    levels,
  }: {
    room: RoomListItemView;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  } = $props();
  const core = useCoreClient();
  let data = $state('');
  let loading = $state(false);
  let failed = $state(false);
  const copied = new Copied();

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    try {
      data = await collectRoomDebugData(
        core.rpc,
        $state.snapshot(room),
        $state.snapshot(permissions),
        $state.snapshot(levels)
      );
    } catch (error) {
      console.warn('[sable room] collecting debug data failed', error);
      failed = true;
    } finally {
      loading = false;
    }
  }

  async function copy(): Promise<void> {
    failed = !(await copied.copy(data, undefined, { toastOnError: false }));
  }

  async function download(): Promise<void> {
    failed = false;
    const filename = `sable-${room.room_kind === 'space' ? 'space' : 'room'}-data-${String(Date.now())}.json`;
    try {
      failed =
        (await saveBytes(new TextEncoder().encode(data), filename, 'application/json')) ===
        'failed';
    } catch (error) {
      console.warn('[sable room] saving debug data failed', error);
      failed = true;
    }
  }
</script>

<SettingsSection
  headingId="room-developer-data"
  title={i18n.t(room.room_kind === 'space' ? 'room.devSpaceDataTitle' : 'room.devRoomDataTitle')}
  description={i18n.t('room.devDataDescription')}
>
  <div class="data settings-form">
    {#if data}
      <Label for="room-dev-data">{i18n.t('room.devDataJson')}</Label>
      <TextArea id="room-dev-data" value={data} readonly rows={12} spellcheck="false" />
    {/if}
    {#if failed}
      <Alert variant="critical" role="alert">{i18n.t('room.devDataFailed')}</Alert>
    {/if}
    <div class="actions">
      <Button variant="secondary" {loading} onclick={() => void load()}>
        {i18n.t('room.devDataLoad')}
      </Button>
      {#if data}
        <Button variant="secondary" disabled={loading} onclick={() => void copy()}>
          {i18n.t(copied.value ? 'common.copied' : 'room.devDataCopy')}
        </Button>
        <Button variant="secondary" disabled={loading} onclick={() => void download()}>
          {i18n.t('room.devDataDownload')}
        </Button>
      {/if}
    </div>
  </div>
</SettingsSection>

<style>
  .data {
    display: grid;
    gap: var(--space-200);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }
</style>
