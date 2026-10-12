<script lang="ts">
  import type { AvatarEditView, FieldEdit } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import { i18n } from '#lib/i18n.js';
  import { downscaledAvatar, encryptAttachment } from '#lib/profile/encrypted-file.js';
  import { profileOverrides, type OverrideEdit } from '#lib/profile/profile-overrides.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

  interface Props {
    open: boolean;
    userId: string;
    realName: string;
    realAvatar: string | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, userId, realName, realAvatar, onOpenChange }: Props = $props();
  const core = useCoreClient();
  const fieldId = $props.id();

  let name = $state('');
  let color = $state('');
  let avatar = $state.raw<AvatarEditView>({ kind: 'clear' });
  let avatarSrc = $derived(avatarPreview(avatar));
  let locked = $derived(profileOverrides.protection === 'locked');
  let sealed = $derived(profileOverrides.protection === 'sealed' || profileOverrides.canSeal);
  let busy = $state(false);
  let failed = $state(false);

  $effect(() => {
    if (!open) return;
    const current = profileOverrides.of(userId);
    const colors = profileOverrides.colors(userId);
    name = current?.display_name.kind === 'set' ? current.display_name.value : '';
    color = colors?.light ?? colors?.dark ?? '';
    avatar = current?.avatar.kind === 'set' ? { kind: 'keep' } : { kind: 'clear' };
    failed = false;
  });

  function avatarPreview(edit: AvatarEditView): string | undefined {
    switch (edit.kind) {
      case 'keep': {
        const current = profileOverrides.of(userId)?.avatar;
        return current?.kind === 'set' ? current.value : undefined;
      }
      case 'url':
        return edit.url;
      case 'encrypted':
        return JSON.stringify(edit.file);
      case 'clear':
        return undefined;
    }
  }

  function field(value: string): FieldEdit {
    return value === '' ? { kind: 'clear' } : { kind: 'set', value };
  }

  async function pickAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    busy = true;
    try {
      const upright = await uprightJpeg(file);
      if (sealed) {
        const scaled = await downscaledAvatar(upright);
        const { ciphertext, file: encrypted } = await encryptAttachment(
          new Uint8Array(await scaled.arrayBuffer())
        );
        avatar = {
          kind: 'encrypted',
          file: {
            ...encrypted,
            url: await core.commands.uploadMedia('application/octet-stream', ciphertext),
          },
        };
      } else {
        avatar = {
          kind: 'url',
          url: await core.commands.uploadMedia(
            upright.type || 'image/*',
            new Uint8Array(await upright.arrayBuffer())
          ),
        };
      }
    } catch (error) {
      console.warn('[sable profile] override avatar upload failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function save(edit: OverrideEdit): Promise<void> {
    busy = true;
    failed = false;
    try {
      await profileOverrides.set(userId, edit);
      onOpenChange(false);
    } catch (error) {
      console.warn('[sable profile] override not saved', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  function confirm(): void {
    void save({ display_name: field(name.trim()), avatar, color: field(color) });
  }

  function reset(): void {
    void save({
      display_name: { kind: 'clear' },
      avatar: { kind: 'clear' },
      color: { kind: 'clear' },
    });
  }
</script>

<ConfirmDialog
  {open}
  {onOpenChange}
  title={$i18n.t('timeline.profileOverrideTitle')}
  description={$i18n.t(
    locked
      ? 'timeline.profileOverrideLocked'
      : sealed
        ? 'timeline.profileOverrideSealedHint'
        : 'timeline.profileOverrideHint'
  )}
  confirmLabel={$i18n.t('common.save')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('common.cancel')}
  busy={busy || locked}
  error={failed ? $i18n.t('errors.actionFailed') : null}
  onConfirm={confirm}
>
  <div class="override-avatar">
    <Avatar id={userId} src={avatarSrc ?? realAvatar} alt="" name={name || realName} size="large" />
    <label class="file-button btn btn-secondary btn-small">
      <input
        type="file"
        accept="image/*"
        disabled={busy}
        onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
          void pickAvatar(event.currentTarget.files?.[0]);
        }}
      />
      {$i18n.t('common.chooseAPicture')}
    </label>
    {#if avatar.kind !== 'clear'}
      <Button variant="ghost" size="small" onclick={() => (avatar = { kind: 'clear' })}>
        {$i18n.t('timeline.profileOverrideAvatarReset')}
      </Button>
    {/if}
  </div>
  <FormField {fieldId} label={$i18n.t('timeline.profileOverrideName')}>
    <TextInput id={fieldId} bind:value={name} placeholder={realName} maxlength={255} />
  </FormField>
  <ColorSetting
    label={$i18n.t('timeline.profileOverrideColor')}
    bind:value={color}
    onCommit={() => {}}
    onReset={() => (color = '')}
  />
  {#if profileOverrides.of(userId)}
    <Button variant="ghost" size="small" disabled={busy} onclick={reset}>
      {$i18n.t('timeline.profileOverrideRemove')}
    </Button>
  {/if}
</ConfirmDialog>

<style>
  .override-avatar {
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
