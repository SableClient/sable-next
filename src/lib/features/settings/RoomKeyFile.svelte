<script lang="ts">
  import { CoreError } from '#src/transport';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import { pickFiles, saveBytes } from '#lib/platform/files.js';
  import { transfersRoomKeys } from '#lib/platform/room-keys.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const EXPORT_NAME = 'sable-keys.txt';

  const core = useCoreClient();

  let exportOpen = $state(false);
  let exportPassphrase = $state('');
  let exportConfirm = $state('');
  let exporting = $state(false);

  let fileInput = $state<HTMLInputElement>();
  let importFile = $state.raw<File | null>(null);
  let importPassphrase = $state('');
  let importing = $state(false);

  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  let mismatch = $derived(exportConfirm !== '' && exportConfirm !== exportPassphrase);

  function importMessageFor(cause: unknown): string {
    if (cause instanceof CoreError && cause.detail.code === 'denied') {
      return t('settings.roomKeysWrongPassphrase');
    }
    if (cause instanceof CoreError && cause.detail.code === 'invalid_key_export') {
      return t('settings.roomKeysInvalidFile');
    }
    return t('settings.roomKeysImportFailed');
  }

  function closeExport(): void {
    exportOpen = false;
    exportPassphrase = '';
    exportConfirm = '';
  }

  function closeImport(): void {
    importFile = null;
    importPassphrase = '';
  }

  async function exportKeys(): Promise<void> {
    exporting = true;
    error = null;
    notice = null;
    try {
      const armored = await core.commands.exportRoomKeys(exportPassphrase);
      const outcome = await saveBytes(new TextEncoder().encode(armored), EXPORT_NAME, 'text/plain');
      if (outcome === 'failed') {
        error = t('settings.roomKeysExportFailed');
      } else if (outcome === 'saved') {
        notice = t('settings.roomKeysExported', { name: EXPORT_NAME });
        closeExport();
      }
    } catch (cause) {
      console.warn('[sable settings] room key export failed', cause);
      error = t('settings.roomKeysExportFailed');
    } finally {
      exporting = false;
    }
  }

  function chooseImport(files: File[]): void {
    const [file] = files;
    if (!file) return;
    error = null;
    notice = null;
    importPassphrase = '';
    importFile = file;
  }

  async function pickImport(): Promise<void> {
    const picked = await pickFiles('*/*');
    if (picked === null) fileInput?.click();
    else chooseImport(picked);
  }

  async function importKeys(): Promise<void> {
    const file = importFile;
    if (!file) return;
    importing = true;
    error = null;
    notice = null;
    try {
      const { imported, total } = await core.commands.importRoomKeys(
        await file.text(),
        importPassphrase
      );
      notice = t('settings.roomKeysImported', { imported, total });
      closeImport();
    } catch (cause) {
      console.warn('[sable settings] room key import failed', cause);
      error = importMessageFor(cause);
    } finally {
      importing = false;
    }
  }
</script>

{#if transfersRoomKeys()}
  <SettingsSection headingId="room-keys-heading" title={$i18n.t('settings.roomKeys')}>
    <ul class="settings-rows">
      <SettingsRow
        id="room-keys-export"
        title={$i18n.t('settings.roomKeysExport')}
        description={$i18n.t('settings.roomKeysExportDescription')}
      >
        {#if !exportOpen}
          <Button variant="secondary" size="small" onclick={() => (exportOpen = true)}>
            {$i18n.t('settings.roomKeysExportAction')}
          </Button>
        {/if}
      </SettingsRow>
    </ul>

    {#if exportOpen}
      <form
        class="settings-form room-keys-form"
        onsubmit={(event) => {
          event.preventDefault();
          void exportKeys();
        }}
      >
        <Label for="room-keys-export-passphrase">{$i18n.t('settings.roomKeysPassphrase')}</Label>
        <TextInput
          id="room-keys-export-passphrase"
          type="password"
          autocomplete="new-password"
          bind:value={exportPassphrase}
          readonly={exporting}
          required
          autofocus
        />
        <Label for="room-keys-export-confirm">{$i18n.t('settings.roomKeysConfirmPassphrase')}</Label
        >
        <TextInput
          id="room-keys-export-confirm"
          type="password"
          autocomplete="new-password"
          bind:value={exportConfirm}
          readonly={exporting}
          aria-invalid={mismatch}
          required
        />
        {#if mismatch}
          <p class="settings-note" role="alert">{$i18n.t('settings.roomKeysPassphraseMismatch')}</p>
        {/if}
        <div class="form-actions">
          <Button
            type="submit"
            loading={exporting}
            disabled={!exportPassphrase || exportPassphrase !== exportConfirm}
          >
            {$i18n.t('settings.roomKeysExportAction')}
          </Button>
          <Button variant="ghost" disabled={exporting} onclick={closeExport}>
            {$i18n.t('settings.cancel')}
          </Button>
        </div>
      </form>
    {/if}

    <ul class="settings-rows">
      <SettingsRow
        id="room-keys-import"
        title={$i18n.t('settings.roomKeysImport')}
        description={$i18n.t('settings.roomKeysImportDescription')}
      >
        {#if !importFile}
          <Button variant="secondary" size="small" onclick={() => void pickImport()}>
            {$i18n.t('settings.roomKeysImportAction')}
          </Button>
        {/if}
        <input
          bind:this={fileInput}
          class="screen-reader-only"
          type="file"
          accept=".txt,text/plain"
          tabindex="-1"
          aria-hidden="true"
          onchange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            chooseImport(files);
          }}
        />
      </SettingsRow>
    </ul>

    {#if importFile}
      <form
        class="settings-form room-keys-form"
        onsubmit={(event) => {
          event.preventDefault();
          void importKeys();
        }}
      >
        <p class="settings-note room-keys-file">{importFile.name}</p>
        <Label for="room-keys-import-passphrase">{$i18n.t('settings.roomKeysPassphrase')}</Label>
        <TextInput
          id="room-keys-import-passphrase"
          type="password"
          autocomplete="off"
          bind:value={importPassphrase}
          readonly={importing}
          required
          autofocus
        />
        <div class="form-actions">
          <Button type="submit" loading={importing}>
            {$i18n.t('settings.roomKeysImportAction')}
          </Button>
          <Button variant="ghost" disabled={importing} onclick={closeImport}>
            {$i18n.t('settings.cancel')}
          </Button>
        </div>
      </form>
    {/if}

    {#if error || notice}
      <div class="settings-form">
        {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
        {#if notice}<Alert variant="success" role="status">{notice}</Alert>{/if}
      </div>
    {/if}
  </SettingsSection>
{/if}

<style>
  .room-keys-form {
    background: var(--surface-container);
    border-top: var(--border-width) solid var(--bg-container-line);
    gap: var(--space-200);
  }

  .room-keys-file {
    overflow-wrap: anywhere;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }
</style>
