<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import { i18n } from '#lib/i18n.js';
  import { NAME_COLOR_FIELD } from '#lib/profile/fields.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
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
  let avatar = $state<string | undefined>(undefined);
  let busy = $state(false);
  let failed = $state(false);

  $effect(() => {
    if (!open) return;
    const current = profileOverrides.of(userId);
    const colors = profileOverrides.colors(userId);
    name = typeof current?.displayname === 'string' ? current.displayname : '';
    color = colors?.light ?? colors?.dark ?? '';
    avatar = typeof current?.avatar_url === 'string' ? current.avatar_url : undefined;
    failed = false;
  });

  async function pickAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    busy = true;
    try {
      const upright = await uprightJpeg(file);
      avatar = await core.commands.uploadMedia(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
    } catch (error) {
      console.warn('[sable profile] override avatar upload failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function save(fields: Record<string, unknown>): Promise<void> {
    busy = true;
    failed = false;
    try {
      await profileOverrides.set(userId, fields);
      onOpenChange(false);
    } catch (error) {
      console.warn('[sable profile] override not saved', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  function confirm(): void {
    void save({
      displayname: name.trim() || undefined,
      avatar_url: avatar,
      [NAME_COLOR_FIELD]: color ? { on_light: color, on_dark: color } : undefined,
    });
  }

  function reset(): void {
    void save({ displayname: undefined, avatar_url: undefined, [NAME_COLOR_FIELD]: undefined });
  }
</script>

<ConfirmDialog
  {open}
  {onOpenChange}
  title={$i18n.t('timeline.profileOverrideTitle')}
  description={$i18n.t('timeline.profileOverrideHint')}
  confirmLabel={$i18n.t('timeline.profileOverrideSave')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('timeline.profileOverrideCancel')}
  {busy}
  error={failed ? $i18n.t('errors.actionFailed') : null}
  onConfirm={confirm}
>
  <div class="override-avatar">
    <Avatar id={userId} src={avatar ?? realAvatar} alt="" name={name || realName} size="large" />
    <label class="file-button btn btn-secondary btn-small">
      <input
        type="file"
        accept="image/*"
        disabled={busy}
        onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
          void pickAvatar(event.currentTarget.files?.[0]);
        }}
      />
      {$i18n.t('timeline.profileOverrideAvatar')}
    </label>
    {#if avatar !== undefined}
      <Button variant="ghost" size="small" onclick={() => (avatar = undefined)}>
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
