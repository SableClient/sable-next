<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomSummary,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { saveFile, savesNatively } from '#lib/platform/files.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import { collectRoomDebugData } from './room-debug-data.js';

  let {
    room,
    permissions,
    levels,
  }: {
    room: RoomSummary;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  } = $props();
  const core = useCoreClient();
  let data = $state('');
  let loading = $state(false);
  let failed = $state(false);
  let copied = $state(false);

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    copied = false;
    try {
      data = await collectRoomDebugData(
        core.commands,
        $state.snapshot(room),
        $state.snapshot(permissions),
        $state.snapshot(levels)
      );
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  async function copy(): Promise<void> {
    failed = false;
    try {
      await navigator.clipboard.writeText(data);
      copied = true;
    } catch {
      failed = true;
    }
  }

  async function download(): Promise<void> {
    failed = false;
    const filename = `sable-${room.is_space ? 'space' : 'room'}-data-${String(Date.now())}.json`;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    try {
      if (savesNatively()) {
        failed = (await saveFile(url, filename)) === 'failed';
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      }
    } catch {
      failed = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
</script>

<SettingsSection
  headingId="room-developer-data"
  title={$i18n.t(room.is_space ? 'room.devSpaceDataTitle' : 'room.devRoomDataTitle')}
  description={$i18n.t('room.devDataDescription')}
>
  <div class="data">
    {#if data}
      <Label for="room-dev-data">{$i18n.t('room.devDataJson')}</Label>
      <TextArea id="room-dev-data" value={data} readonly rows={12} spellcheck="false" />
    {/if}
    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('room.devDataFailed')}</Alert>
    {/if}
    <div class="actions">
      <Button variant="secondary" {loading} onclick={() => void load()}>
        {$i18n.t('room.devDataLoad')}
      </Button>
      {#if data}
        <Button variant="secondary" disabled={loading} onclick={() => void copy()}>
          {$i18n.t(copied ? 'room.devDataCopied' : 'room.devDataCopy')}
        </Button>
        <Button variant="secondary" disabled={loading} onclick={() => void download()}>
          {$i18n.t('room.devDataDownload')}
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
