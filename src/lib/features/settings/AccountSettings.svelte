<script lang="ts">
  import { onDestroy } from 'svelte';

  import type { ProfileView } from '#src/generated/ProfileView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import ExtendedProfileSettings from './ExtendedProfileSettings.svelte';

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

  async function saveName(): Promise<void> {
    if (!nameChanged || savingName) return;
    savingName = true;
    error = null;
    try {
      await core.commands.setDisplayName(displayName.trim() || null);
      if (profile) profile = { ...profile, display_name: displayName.trim() || null };
    } catch {
      error = $i18n.t('settings.profileSaveFailed');
    } finally {
      savingName = false;
    }
  }

  async function saveAvatar(): Promise<void> {
    if (!avatarFile || savingAvatar) return;
    savingAvatar = true;
    error = null;
    try {
      const url = await core.uploadAvatar(
        avatarFile.type || 'image/*',
        new Uint8Array(await avatarFile.arrayBuffer())
      );
      if (profile) profile = { ...profile, avatar_url: url };
      setAvatar(null);
    } catch {
      error = $i18n.t('settings.profileSaveFailed');
    } finally {
      savingAvatar = false;
    }
  }

  async function removeAvatar(): Promise<void> {
    if (savingAvatar || !profile?.avatar_url) return;
    savingAvatar = true;
    error = null;
    try {
      await core.commands.setAvatarUrl(null);
      profile = { ...profile, avatar_url: null };
    } catch {
      error = $i18n.t('settings.profileSaveFailed');
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
      displayName = next.display_name ?? '';
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
        <div class="profile-settings">
          {#if profile}<ExtendedProfileSettings
              {profile}
              onSaved={refreshProfile}
              section="banner"
            />{/if}
          <div class="avatar-row">
            <Avatar src={avatarUrl} name={displayName || userId} size="large" />
            <div class="avatar-actions">
              <label class="file-button sable-button sable-button-secondary sable-button-small">
                <input
                  type="file"
                  accept="image/*"
                  disabled={savingAvatar}
                  onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                    setAvatar(event.currentTarget.files?.[0] ?? null);
                  }}
                />
                {$i18n.t(profile?.avatar_url ? 'settings.changeAvatar' : 'settings.avatar')}
              </label>
              {#if avatarFile}
                <Button size="small" loading={savingAvatar} onclick={() => void saveAvatar()}>
                  {$i18n.t('settings.save')}
                </Button>
              {:else if profile?.avatar_url}
                <Button
                  variant="danger"
                  size="small"
                  loading={savingAvatar}
                  onclick={() => void removeAvatar()}
                >
                  {$i18n.t('settings.removeAvatar')}
                </Button>
              {/if}
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
              />
              <Button type="submit" loading={savingName} disabled={!nameChanged}>
                {$i18n.t('settings.save')}
              </Button>
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
        <div class="matrix-id">
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
    {/if}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.account-settings) {
    max-width: 56rem;
  }

  .settings-stack,
  .profile-settings {
    display: grid;
    gap: var(--space-3);
  }

  .profile-settings,
  .matrix-id {
    padding: var(--space-3);
  }

  .avatar-row,
  .avatar-actions,
  .name-controls,
  .matrix-id {
    align-items: center;
    display: flex;
    gap: var(--space-2);
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
    gap: var(--space-1);
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
    padding: var(--space-4);
  }
</style>
