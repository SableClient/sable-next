<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import '#lib/ui/primitives/settings-row.css';

  import ChatBackgroundPicker from './ChatBackgroundPicker.svelte';
</script>

<div class="chat-background-settings settings-form">
  <div class="settings-heading-row">
    <label for="chat-background">{i18n.t('settings.chatBackground')}</label>
    <SettingsAnchorLink anchor="chat-background" />
  </div>
  <p>{i18n.t('settings.chatBackgroundHint')}</p>
  <ChatBackgroundPicker
    id="chat-background"
    image={preferences.chatBackgroundImage}
    color={preferences.chatBackgroundColor}
    onImage={(image) => {
      setPreference('chatBackgroundImage', image);
    }}
    onColor={(color) => {
      setPreference('chatBackgroundColor', color);
    }}
  />
</div>

<style>
  .chat-background-settings {
    display: grid;
    gap: var(--space-150);
  }

  label {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
  }

  p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
