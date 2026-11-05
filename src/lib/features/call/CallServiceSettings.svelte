<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    isLockedPreference,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { callServiceUrl } from './call-service-url';
  import '#lib/ui/primitives/settings-row.css';

  let draft = $state<string | null>(null);
  const value = $derived(draft ?? preferences.callServiceUrl);
  const normalized = $derived(callServiceUrl(value));
  const invalid = $derived(value.trim() !== '' && normalized === null);
  const dirty = $derived((normalized ?? value.trim()) !== preferences.callServiceUrl);
  const locked = $derived(isLockedPreference('callServiceUrl'));

  function apply(value: string): void {
    setPreference('callServiceUrl', value);
    draft = null;
  }
</script>

<form
  class="settings-form call-service"
  aria-label={i18n.t('settings.callServiceTitle')}
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    if (dirty && !invalid && !locked) apply(normalized ?? '');
  }}
>
  <label for="call-service-url">{i18n.t('settings.callServiceUrl')}</label>
  <p class="hint settings-description" id="call-service-hint">
    {i18n.t('settings.callServiceUrlHint')}
  </p>
  <TextInput
    id="call-service-url"
    type="url"
    bind:value={() => value, (next) => (draft = next)}
    placeholder="https://rtc.example.org"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    aria-invalid={invalid || undefined}
    aria-describedby={invalid ? 'call-service-hint call-service-error' : 'call-service-hint'}
    disabled={locked}
  />
  {#if invalid}
    <Alert variant="warning" role="status">
      <p id="call-service-error">{i18n.t('settings.callServiceUrlInvalid')}</p>
    </Alert>
  {/if}
  <div class="actions">
    <Button type="submit" variant="primary" size="small" disabled={!dirty || invalid || locked}>
      {i18n.t('common.apply')}
    </Button>
    <Button
      variant="secondary"
      size="small"
      disabled={locked || (preferences.callServiceUrl === '' && draft === null)}
      onclick={() => apply('')}
    >
      {i18n.t('common.reset')}
    </Button>
  </div>
</form>

<style>
  .call-service {
    padding: var(--space-150) var(--space-400);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }
</style>
