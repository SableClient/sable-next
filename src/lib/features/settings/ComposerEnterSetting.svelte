<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference, type EnterKey } from '#lib/settings/preferences.svelte.js';
  import { enterSettingLabels, settingFocusId } from '#lib/settings/registry.js';
  import Switcher from '#lib/ui/primitives/Switcher.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const anchor = settingFocusId('enterForNewline');
  const options = [
    { value: 'send', label: 'settings.composerEnterSends' },
    { value: 'newline', label: 'settings.composerEnterNewline' },
    { value: 'adaptive', label: 'settings.composerEnterAdaptive' },
  ] as const;
  const mode = $derived<EnterKey>(preferences.enterForNewline);
  const labels = $derived(enterSettingLabels(mode));
</script>

<ul class="settings-rows">
  <SettingsRow id={anchor} data-settings-focus={anchor} title={$i18n.t('settings.enterKey')}>
    <Switcher
      label={$i18n.t('settings.enterKey')}
      value={mode}
      items={options.map((option) => ({ value: option.value, label: $i18n.t(option.label) }))}
      onValueChange={(value) => setPreference('enterForNewline', value as EnterKey)}
    />
  </SettingsRow>
</ul>
