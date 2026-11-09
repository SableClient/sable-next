<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { nativeFilePicker } from '#lib/platform/native-file-picker.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

  export interface IconTarget {
    id: string;
    name: string;
    icon: string | null;
    fallback: string | null;
    description: string;
    save: (icon: string | null) => Promise<void> | void;
  }

  interface Props {
    target: IconTarget | null;
    onOpenChange: (open: boolean) => void;
  }

  let { target, onOpenChange }: Props = $props();
  const core = useCoreClient();

  let icon = $derived(target?.icon ?? null);
  let busy = $state(false);
  let failed = $state(false);

  function close(open: boolean): void {
    failed = false;
    onOpenChange(open);
  }

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    busy = true;
    failed = false;
    try {
      const upright = await uprightJpeg(file);
      icon = await core.media.uploadMedia(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
    } catch (error) {
      console.warn('[sable nav] icon upload failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    busy = true;
    failed = false;
    try {
      await target?.save(icon);
      close(false);
    } catch (error) {
      console.warn('[sable nav] icon not saved', error);
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<ConfirmDialog
  open={target !== null}
  onOpenChange={close}
  title={i18n.t('nav.changeIcon')}
  description={target?.description}
  confirmLabel={i18n.t('common.save')}
  confirmVariant="secondary"
  cancelLabel={i18n.t('common.cancel')}
  {busy}
  error={failed ? i18n.t('errors.actionFailed') : null}
  onConfirm={save}
  onCancel={() => {
    close(false);
  }}
>
  {#if target}
    <div class="icon-row">
      <Avatar id={target.id} src={icon ?? target.fallback} alt="" name={target.name} size="large" />
      <label class="file-button btn btn-secondary btn-small">
        <input
          use:nativeFilePicker
          type="file"
          accept="image/*"
          disabled={busy}
          onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
            void pick(event.currentTarget.files?.[0]);
          }}
        />
        {i18n.t('common.chooseAPicture')}
      </label>
      {#if icon !== null}
        <Button variant="ghost" size="small" disabled={busy} onclick={() => (icon = null)}>
          {i18n.t('nav.resetIcon')}
        </Button>
      {/if}
    </div>
  {/if}
</ConfirmDialog>

<style>
  .icon-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .file-button {
    cursor: pointer;
    position: relative;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .file-button:focus-within {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
  }
</style>
