<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
</script>

<div class="quick-css settings-form">
  <label for="quick-css">
    {$i18n.t('settings.quickCss')}
    <TextArea
      id="quick-css"
      rows={10}
      spellcheck={false}
      value={preferences.quickCss}
      aria-describedby="quick-css-hint"
      oninput={(event) => {
        setPreference('quickCss', event.currentTarget.value);
      }}
    />
  </label>
  <p id="quick-css-hint">{$i18n.t('settings.quickCssHint')}</p>
</div>

<style>
  .quick-css {
    display: grid;
    gap: var(--space-150);
  }

  label {
    display: grid;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-150);
  }

  p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
