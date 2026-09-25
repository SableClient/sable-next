<script lang="ts">
  import { onDestroy } from 'svelte';

  import type { ProfileView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';
  import '#lib/ui/primitives/settings-row.css';
  import { findCategory, SETTINGS_ACCOUNT_SECTION } from '#lib/settings/registry.js';
  import ExtendedProfileSettings from './ExtendedProfileSettings.svelte';
  import SettingsCategorySections from './SettingsCategorySections.svelte';

  const category = findCategory(SETTINGS_ACCOUNT_SECTION);

  const core = useCoreClient();
  let profile = $state<ProfileView | null>(null);
  let displayName = $state('');
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);
  let loading = $state(true);
  let savingName = $state(false);
  let savingAvatar = $state(false);
  let copied = $state(false);
  let error = $state<string | null>(null);

  let userId = $derived(core.session?.user_id ?? '');
  let avatarUrl = $derived(avatarPreview ?? profile?.avatar_url ?? null);
  let nameChanged = $derived(displayName !== (profile?.display_name ?? ''));

  onDestroy(() => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  });

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
          displayName = next.display_name ?? '';
        },
        () => {
          if (!cancelled) error = $i18n.t('settings.profileSaveFailed');
        }
      )
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function setAvatar(file: File | null): void {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarFile = file;
    avatarPreview = file ? URL.createObjectURL(file) : null;
  }

  function offerUndo(name: string, undo: () => Promise<void>): void {
    toasts.undoable(t('settings.savedField', { name: t(name) }), {
      label: t('settings.undo'),
      onUndo: () => {
        void undo().catch(() => {
          error = t('settings.profileSaveFailed');
        });
      },
    });
  }

  async function writeName(name: string | null): Promise<void> {
    await core.commands.setDisplayName(name);
    displayName = name ?? '';
    if (profile) profile = { ...profile, display_name: name };
  }

  async function writeAvatar(url: string | null): Promise<void> {
    await core.commands.setAvatarUrl(url);
    if (profile) profile = { ...profile, avatar_url: url };
  }

  async function saveName(): Promise<void> {
    if (!nameChanged || savingName) return;
    const previous = profile?.display_name ?? null;
    savingName = true;
    error = null;
    try {
      await writeName(displayName.trim() || null);
      offerUndo('settings.displayName', () => writeName(previous));
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      savingName = false;
    }
  }

  async function uploadAvatar(file: File): Promise<void> {
    const previous = profile?.avatar_url ?? null;
    setAvatar(file);
    savingAvatar = true;
    error = null;
    try {
      const upright = await uprightJpeg(file);
      const url = await core.uploadAvatar(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
      if (profile) profile = { ...profile, avatar_url: url };
      offerUndo('settings.avatar', () => writeAvatar(previous));
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      setAvatar(null);
      savingAvatar = false;
    }
  }

  async function removeAvatar(): Promise<void> {
    if (savingAvatar || !profile?.avatar_url) return;
    const previous = profile.avatar_url;
    savingAvatar = true;
    error = null;
    try {
      await writeAvatar(null);
      offerUndo('settings.avatar', () => writeAvatar(previous));
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      savingAvatar = false;
    }
  }

  async function copyUserId(): Promise<void> {
    await navigator.clipboard.writeText(userId);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  }

  function refreshProfile(): void {
    if (!userId) return;
    void core.userProfile(userId).then((next) => {
      profile = next;
    });
  }
</script>

<AppPageShell
  title={$i18n.t('settings.account')}
  description={$i18n.t('settings.profileDescription')}
  density="compact"
  class="account-settings"
>
  <div class="settings-stack">
    {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}
    {#if loading}
      <div class="loading" role="status"><Spinner /></div>
    {:else}
      <SettingsSection title={$i18n.t('settings.profile')} headingId="account-profile">
        <div class="settings-form">
          {#if profile}<ExtendedProfileSettings
              {profile}
              onSaved={refreshProfile}
              section="banner"
            />{/if}
          <div class="avatar-setting">
            <span class="setting-label">{$i18n.t('settings.avatar')}</span>
            <div class="avatar-row">
              <div class="avatar-actions">
                <label class="file-button btn btn-secondary btn-small">
                  <input
                    type="file"
                    accept="image/*"
                    disabled={savingAvatar}
                    onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void uploadAvatar(file);
                    }}
                  />
                  {$i18n.t(profile?.avatar_url ? 'settings.changeAvatar' : 'settings.uploadAvatar')}
                </label>
                {#if profile?.avatar_url && !avatarFile}
                  <Button
                    variant="ghost"
                    size="small"
                    loading={savingAvatar}
                    onclick={() => void removeAvatar()}
                  >
                    {$i18n.t('settings.removeAvatar')}
                  </Button>
                {/if}
              </div>
              <Avatar id={userId} src={avatarUrl} name={displayName || userId} size="large" />
            </div>
          </div>
          <form
            class="name-form"
            onsubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <label for="account-display-name">{$i18n.t('settings.displayName')}</label>
            <div class="name-controls">
              <TextInput
                id="account-display-name"
                bind:value={displayName}
                autocomplete="nickname"
                maxlength={255}
                onchange={() => void saveName()}
              />
            </div>
          </form>
        </div>
      </SettingsSection>
      {#if profile}<ExtendedProfileSettings
          {profile}
          onSaved={refreshProfile}
          section="profile"
        />{/if}
      <SettingsSection title={$i18n.t('settings.matrixId')} headingId="account-matrix-id">
        <div class="settings-form matrix-id">
          <code>{userId}</code>
          <Button variant="secondary" size="small" onclick={() => void copyUserId()}>
            {$i18n.t(copied ? 'settings.copied' : 'settings.copy')}
          </Button>
        </div>
      </SettingsSection>
      {#if profile}<ExtendedProfileSettings
          {profile}
          onSaved={refreshProfile}
          section="account"
        />{/if}
      {#if category}<SettingsCategorySections {category} />{/if}
    {/if}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.account-settings) {
    max-width: 56rem;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-400);
  }

  .avatar-row,
  .avatar-actions,
  .name-controls,
  .matrix-id {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .avatar-setting {
    display: grid;
    gap: var(--space-200);
  }

  .avatar-setting .setting-label {
    font-weight: var(--font-weight-medium);
  }

  .avatar-row {
    justify-content: space-between;
  }

  .avatar-actions,
  .name-controls {
    flex-wrap: wrap;
  }

  .file-button {
    cursor: pointer;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .name-form {
    display: grid;
    gap: var(--space-200);
  }

  .name-form label {
    font-weight: var(--font-weight-medium);
  }

  .name-controls :global(.text-input) {
    flex: 1;
    min-width: 0;
  }

  .matrix-id {
    justify-content: space-between;
  }

  .matrix-id code {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: var(--space-500);
  }
</style>
