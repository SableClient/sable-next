<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';

  import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { resolveTheme } from '#lib/settings/theme.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import AuthField from '../shared/AuthField.svelte';

  let { onComplete }: { onComplete: () => void } = $props();
  const systemDark = new MediaQuery('(prefers-color-scheme: dark)');
  const systemTheme = $derived(resolveTheme('system', systemDark.current));

  function choose(kind: 'light' | 'dark'): void {
    setPreference('theme', kind === systemTheme ? 'system' : kind);
  }
</script>

<div class="appearance-setup-card auth-card-surface">
  <AuthField labelId="appearance-setup-title" label={$i18n.t('setup.appearanceTitle')}>
    <p class="hint">
      {$i18n.t(
        preferences.theme === 'system' ? 'setup.appearanceSystem' : 'setup.appearancePinned',
        {
          mode: $i18n
            .t(preferences.theme === 'light' ? 'settings.themeLight' : 'settings.themeDark')
            .toLowerCase(),
        }
      )}
    </p>
  </AuthField>

  <CustomThemes onboarding onThemeChosen={choose} />
  <Button variant="primary" block onclick={onComplete}>{$i18n.t('auth.continue')}</Button>
</div>

<style>
  .appearance-setup-card {
    min-width: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .appearance-setup-card :global(.custom-themes.settings-form) {
    padding: 0;
  }
</style>
