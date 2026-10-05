<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    mediaPreviewSettings,
    type MediaPreviewConfig,
  } from '#lib/settings/media-previews.svelte.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import '#lib/ui/primitives/settings-row.css';

  const avatarsId = $props.id();

  function save(next: MediaPreviewConfig): void {
    mediaPreviewSettings.set(next).catch((error: unknown) => {
      console.warn('[sable settings] media preview settings not saved', error);
      toasts.error($i18n.t('errors.actionFailed'));
    });
  }
</script>

<ul class="settings-rows">
  <SettingsRow title={$i18n.t('settings.inviteAvatars')} control={avatarsId}>
    <Switch
      id={avatarsId}
      checked={mediaPreviewSettings.inviteAvatars === 'on'}
      label={$i18n.t('settings.inviteAvatars')}
      onCheckedChange={(checked) => {
        save({ invite_avatars: checked ? 'on' : 'off' });
      }}
    />
  </SettingsRow>
</ul>

<style>
  .settings-rows {
    border-bottom: var(--border-width) solid var(--bg-container-line);
  }
</style>
