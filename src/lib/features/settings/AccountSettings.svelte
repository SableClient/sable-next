<script lang="ts">
  import type { ProfileView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import { findCategory, SETTINGS_ACCOUNT_SECTION } from '#lib/settings/registry.js';
  import ExtendedProfileSettings from './ExtendedProfileSettings.svelte';
  import DeleteAccountSetting from './DeleteAccountSetting.svelte';
  import LinkDeviceSetting from './LinkDeviceSetting.svelte';
  import ProfileEditor from './ProfileEditor.svelte';
  import SettingsCategorySections from './SettingsCategorySections.svelte';
  import { supporter } from '#lib/supporter/supporter.svelte.js';
  import SupporterSettings from './SupporterSettings.svelte';

  const category = findCategory(SETTINGS_ACCOUNT_SECTION);

  const core = useCoreClient();
  let profile = $state.raw<ProfileView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let badge = $derived(supporter.badge);

  let userId = $derived(core.session?.user_id ?? '');

  $effect(() => {
    if (!userId) return;

    let cancelled = false;
    loading = true;
    error = null;
    void core
      .userProfile(userId)
      .then(
        (next) => {
          if (cancelled) return;
          profile = next;
        },
        () => {
          if (!cancelled) error = i18n.t('settings.profileSaveFailed');
        }
      )
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function refreshProfile(): void {
    if (!userId) return;
    void core.refreshUserProfile(userId).then(
      (next) => {
        profile = next;
      },
      (cause: unknown) => {
        console.warn('[sable settings] profile refresh failed', cause);
      }
    );
  }
</script>

<AppPageShell title={i18n.t('settings.account')} density="compact" class="account-settings">
  <div class="settings-stack">
    {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}
    {#if loading}
      <div class="loading" role="status"><Spinner /></div>
    {:else}
      {#if profile}<ProfileEditor {profile} {userId} onSaved={refreshProfile} />{/if}
      {#if profile}<ExtendedProfileSettings {profile} />{/if}
      <LinkDeviceSetting />
      {#if category}<SettingsCategorySections {category} />{/if}

      {#if supporter.enabled && badge}
        <SupporterSettings />
      {/if}
      <DeleteAccountSetting />
    {/if}
  </div>
</AppPageShell>

<style>
  :global(main.app-page-shell.account-settings) {
    overflow: clip;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: minmax(0, 1fr);
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: var(--space-500);
  }
</style>
