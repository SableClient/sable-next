<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { pickFiles, saveBytes } from '#lib/platform/files.js';
  import { customThemes, replaceCustomThemes } from '#lib/settings/custom-themes.svelte.js';
  import {
    applyPreferences,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import {
    parseSettingsFile,
    settingsFileJson,
    settingsFileName,
    type SettingsImport,
  } from '#lib/settings/settings-file.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  let fileInput = $state<HTMLInputElement>();
  let pending = $state.raw<SettingsImport | null>(null);
  let error = $state<string | null>(null);
  let exporting = $state(false);

  async function exportSettings(): Promise<void> {
    exporting = true;
    error = null;
    try {
      const bytes = new TextEncoder().encode(settingsFileJson(preferences, customThemes));
      if ((await saveBytes(bytes, settingsFileName(), 'application/json')) === 'failed') {
        error = $i18n.t('settings.settingsExportFailed');
      }
    } finally {
      exporting = false;
    }
  }

  async function readFile(files: File[]): Promise<void> {
    const [file] = files;
    if (!file) return;
    error = null;
    try {
      pending = parseSettingsFile(await file.text(), preferences, customThemes);
    } catch (cause) {
      console.warn('[sable settings] the settings file could not be read', cause);
      error = $i18n.t('settings.settingsImportInvalid');
    }
  }

  async function chooseFile(): Promise<void> {
    const picked = await pickFiles('*/*');
    if (picked === null) fileInput?.click();
    else await readFile(picked);
  }

  function confirmImport(): void {
    const next = pending;
    if (!next) return;
    applyPreferences(next.preferences);
    replaceCustomThemes(next.themes);
    if (next.push) {
      setPreference('pushGatewayUrl', next.push.pushGatewayUrl);
      setPreference('pushVapidKey', next.push.pushVapidKey);
      setPreference('pushAppId', next.push.pushAppId);
    }
    pending = null;
  }
</script>

<ul class="settings-rows">
  <SettingsRow
    title={$i18n.t('settings.settingsFileTitle')}
    description={$i18n.t('settings.settingsFileHint')}
  >
    <Button variant="secondary" size="small" onclick={() => void chooseFile()}>
      {$i18n.t('settings.settingsImport')}
    </Button>
    <Button
      variant="secondary"
      size="small"
      loading={exporting}
      onclick={() => void exportSettings()}
    >
      {$i18n.t('settings.settingsExport')}
    </Button>
    <input
      bind:this={fileInput}
      class="screen-reader-only"
      type="file"
      accept=".json,application/json"
      tabindex="-1"
      aria-hidden="true"
      onchange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        void readFile(files);
      }}
    />
  </SettingsRow>
</ul>

{#if error}
  <div class="settings-form">
    <Alert variant="critical">{error}</Alert>
  </div>
{/if}

<ConfirmDialog
  open={pending !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pending = null;
  }}
  title={$i18n.t('settings.settingsImportTitle')}
  description={pending?.push
    ? $i18n.t('settings.settingsImportConfirmGateway', { gateway: pending.push.pushGatewayUrl })
    : $i18n.t('settings.settingsImportConfirm')}
  confirmLabel={$i18n.t('settings.settingsImport')}
  onConfirm={confirmImport}
/>
