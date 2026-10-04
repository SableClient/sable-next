<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    COMPOSER_SEPARATOR_MAX,
    composerSeparatorCount,
    preferences,
    setPreference,
    withComposerSeparatorCount,
  } from '#lib/settings/preferences.svelte.js';
  import { findCategory, settingFocusId, type BooleanSetting } from '#lib/settings/registry.js';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/form-control.css';
  import '#lib/ui/primitives/settings-row.css';

  const chips = (findCategory('composer')?.items ?? []).filter(
    (setting): setting is BooleanSetting =>
      setting.section === 'composer-buttons' && setting.type === 'boolean'
  );
  const anchor = settingFocusId('composerSeparatorCount');
  const separatorCount = $derived(composerSeparatorCount(preferences.composerButtonOrder));
</script>

<ul class="settings-rows">
  <SettingsRow title={$i18n.t('settings.groups.buttons')} wide>
    <div class="chip-wrap" role="group" aria-label={$i18n.t('settings.groups.buttons')}>
      {#each chips as chip (chip.key)}
        {@const on = preferences[chip.key]}
        {@const chipAnchor = settingFocusId(chip.key)}
        <Pill
          onclick={() => setPreference(chip.key, !preferences[chip.key])}
          id={chipAnchor}
          data-settings-focus={chipAnchor}
          variant={on ? 'primary' : 'outline'}
          aria-pressed={on}
          aria-label={$i18n.t(chip.name)}
        >
          <chip.icon />{$i18n.t('settings.composerChipLabels.' + chip.key)}
        </Pill>
      {/each}
    </div>
  </SettingsRow>
  <SettingsRow
    id={anchor}
    data-settings-focus={anchor}
    title={$i18n.t('settings.composerSeparatorCount')}
    control="{anchor}-count"
  >
    <label class="form-control range-reading">
      <input
        id="{anchor}-count"
        class="range-input"
        type="number"
        inputmode="numeric"
        min={0}
        max={COMPOSER_SEPARATOR_MAX}
        step={1}
        value={separatorCount}
        aria-label={$i18n.t('settings.composerSeparatorCount')}
        onchange={(event) => {
          const typed = Number(event.currentTarget.value);
          if (event.currentTarget.value !== '' && Number.isFinite(typed)) {
            setPreference(
              'composerButtonOrder',
              withComposerSeparatorCount(preferences.composerButtonOrder, typed)
            );
          }
          event.currentTarget.value = String(
            composerSeparatorCount(preferences.composerButtonOrder)
          );
        }}
      />
    </label>
  </SettingsRow>
</ul>

<style>
  .chip-wrap {
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: var(--space-150);
    justify-content: flex-end;
    margin-inline-start: auto;
    max-width: 100%;
    min-width: 0;
  }

  .chip-wrap :global(.pill) {
    --pill-size: var(--control-height-small);

    flex: 0 0 auto;
  }

  .chip-wrap :global(.pill svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
