<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import { saveRoomKeys } from '#lib/features/settings/room-key-export.js';
  import { confirmSaved } from '#lib/ui/download.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open: boolean;
    roomId: string;
  }

  let { open = $bindable(), roomId }: Props = $props();
  const core = useCoreClient();

  let passphrase = $state('');
  let confirmation = $state('');
  let exporting = $state(false);
  let failed = $state(false);

  let mismatch = $derived(confirmation !== '' && confirmation !== passphrase);

  function reset(): void {
    passphrase = '';
    confirmation = '';
    failed = false;
  }

  async function exportKeys(): Promise<void> {
    exporting = true;
    failed = false;
    try {
      const outcome = await saveRoomKeys(
        core.rpc.encryption,
        passphrase,
        roomId,
        'sable-room-keys.txt'
      );
      if (outcome === 'failed') failed = true;
      else if (outcome === 'saved') {
        confirmSaved();
        open = false;
        reset();
      }
    } catch (error) {
      console.warn('[sable room] room key export failed', error);
      failed = true;
    } finally {
      exporting = false;
    }
  }
</script>

<ConfirmDialog
  bind:open
  title={i18n.t('room.exportKeys')}
  description={i18n.t('room.exportKeysDescription')}
  confirmLabel={i18n.t('settings.roomKeysExportAction')}
  onOpenChange={(next) => {
    if (!next) reset();
  }}
  confirmVariant="secondary"
  busy={exporting}
  confirmDisabled={!passphrase || passphrase !== confirmation}
  error={failed ? t('settings.roomKeysExportFailed') : null}
  onConfirm={() => {
    void exportKeys();
  }}
>
  <Label for="room-export-passphrase">{i18n.t('settings.roomKeysPassphrase')}</Label>
  <TextInput
    id="room-export-passphrase"
    type="password"
    autocomplete="new-password"
    bind:value={passphrase}
    readonly={exporting}
    required
  />
  <Label for="room-export-confirm">{i18n.t('settings.roomKeysConfirmPassphrase')}</Label>
  <TextInput
    id="room-export-confirm"
    type="password"
    autocomplete="new-password"
    bind:value={confirmation}
    readonly={exporting}
    aria-invalid={mismatch}
    required
  />
  {#if mismatch}
    <p role="alert">{i18n.t('settings.roomKeysPassphraseMismatch')}</p>
  {/if}
</ConfirmDialog>
