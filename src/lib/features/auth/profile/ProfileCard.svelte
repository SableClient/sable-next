<script lang="ts">
  import CameraIcon from 'phosphor-svelte/lib/CameraIcon';
  import { untrack } from 'svelte';

  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    userId: string;
    displayName: string;
    pronouns: string;
    nameColor: string;
    status: string;
    bannerPreview: string | null;
    avatarPreview: string | null;
    isSaving: boolean;
    error: string | null;
    onDisplayName: (value: string) => void;
    onPronouns: (value: string) => void;
    onNameColor: (value: string) => void;
    onStatus: (value: string) => void;
    onBanner: (file: File | null) => void;
    onAvatar: (file: File | null) => void;
    onContinue: () => void;
    onSkip: () => void;
  }

  let {
    userId,
    displayName,
    pronouns,
    nameColor,
    status,
    bannerPreview,
    avatarPreview,
    isSaving,
    error,
    onDisplayName,
    onPronouns,
    onNameColor,
    onStatus,
    onBanner,
    onAvatar,
    onContinue,
    onSkip,
  }: Props = $props();

  let moreOpen = $state(false);
  let color = $state(untrack(() => nameColor));
</script>

<form
  class="profile-card auth-card-surface"
  aria-labelledby="profile-title"
  onsubmit={(event) => {
    event.preventDefault();
    onContinue();
  }}
>
  <AuthField labelId="profile-title" label={$i18n.t('setup.profileTitle')}>
    <AuthInfoBox>{$i18n.t('auth.profileIntro')}</AuthInfoBox>
  </AuthField>

  <div class="avatar-picker">
    <label class="avatar-hit" for="profile-avatar">
      <Avatar
        class="avatar-preview"
        id={userId}
        src={avatarPreview}
        alt=""
        name={displayName || userId}
        size="large"
      />
      <span class="avatar-badge" aria-hidden="true"><CameraIcon weight="fill" /></span>
    </label>
    <div class="avatar-actions">
      <span class="avatar-label">{$i18n.t('auth.avatar')}</span>
      <div class="avatar-buttons">
        <label class="file-button btn btn-secondary btn-small">
          <input
            id="profile-avatar"
            type="file"
            accept="image/*"
            aria-label={$i18n.t(avatarPreview ? 'auth.replaceAvatar' : 'settings.uploadAvatar')}
            onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
              onAvatar(event.currentTarget.files?.[0] ?? null);
            }}
          />
          {$i18n.t(avatarPreview ? 'auth.replaceAvatar' : 'settings.uploadAvatar')}
        </label>
        {#if avatarPreview}
          <Button
            variant="ghost"
            size="small"
            onclick={() => {
              onAvatar(null);
              const input = document.getElementById('profile-avatar');
              if (input instanceof HTMLInputElement) input.value = '';
            }}
          >
            {$i18n.t('auth.removeAvatar')}
          </Button>
        {/if}
      </div>
    </div>
  </div>

  <FormField dense fieldId="profile-display-name" label={$i18n.t('auth.displayName')}>
    <TextInput
      id="profile-display-name"
      value={displayName}
      autocomplete="nickname"
      maxlength={255}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onDisplayName(event.currentTarget.value);
      }}
    />
  </FormField>

  <FormField dense fieldId="profile-pronouns" label={$i18n.t('settings.pronouns')}>
    <TextInput
      id="profile-pronouns"
      value={pronouns}
      placeholder={$i18n.t('settings.pronounsPlaceholder')}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onPronouns(event.currentTarget.value);
      }}
    />
  </FormField>

  <details class="more-options" bind:open={moreOpen}>
    <summary>{$i18n.t('auth.moreProfileOptions')}</summary>
    <div class="more-list">
      <ColorSetting
        label={$i18n.t('auth.nameColor')}
        bind:value={color}
        onCommit={() => {
          onNameColor(color);
        }}
        onReset={() => {
          color = '';
          onNameColor('');
        }}
      />
      <FormField dense fieldId="profile-status" label={$i18n.t('settings.status')}>
        <TextInput
          id="profile-status"
          value={status}
          maxlength={255}
          placeholder={$i18n.t('settings.statusPlaceholder')}
          oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
            onStatus(event.currentTarget.value);
          }}
        />
      </FormField>
      <div class="banner-setting">
        <span class="avatar-label">{$i18n.t('auth.banner')}</span>
        {#if bannerPreview}<img class="banner-preview" src={bannerPreview} alt="" />{/if}
        <div class="avatar-buttons">
          <label class="file-button btn btn-secondary btn-small">
            <input
              id="profile-banner"
              type="file"
              accept="image/*"
              aria-label={$i18n.t(bannerPreview ? 'settings.changeBanner' : 'settings.saveBanner')}
              onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                onBanner(event.currentTarget.files?.[0] ?? null);
              }}
            />
            {$i18n.t(bannerPreview ? 'settings.changeBanner' : 'settings.saveBanner')}
          </label>
          {#if bannerPreview}
            <Button
              variant="ghost"
              size="small"
              onclick={() => {
                onBanner(null);
                const input = document.getElementById('profile-banner');
                if (input instanceof HTMLInputElement) input.value = '';
              }}
            >
              {$i18n.t('settings.removeButton')}
            </Button>
          {/if}
        </div>
      </div>
    </div>
  </details>

  <AuthStatusSlot message={error} />

  <Button type="submit" variant="primary" block loading={isSaving}>
    {$i18n.t('auth.continue')}
  </Button>
</form>

<AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} disabled={isSaving} />

<style>
  .profile-card {
    min-width: 0;
  }

  .avatar-picker {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: auto minmax(0, 1fr);
  }

  .avatar-hit {
    border-radius: var(--radius);
    cursor: pointer;
    display: block;
    position: relative;
  }

  .avatar-badge {
    align-items: center;
    background: var(--primary-main);
    border: calc(var(--border-width) * 2) solid var(--surface-container);
    border-radius: 50%;
    bottom: calc(var(--space-100) * -1);
    color: var(--primary-on-main);
    display: flex;
    height: 1.75rem;
    justify-content: center;
    position: absolute;
    right: calc(var(--space-100) * -1);
    width: 1.75rem;
  }

  .avatar-badge :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .avatar-actions {
    display: grid;
    gap: var(--space-150);
    min-width: 0;
  }

  .avatar-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .avatar-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .file-button {
    cursor: pointer;
    position: relative;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  @media (pointer: coarse) {
    .file-button {
      min-height: 2.75rem;
    }
  }

  .file-button:focus-within {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
  }

  :global(.avatar-root.avatar-preview) {
    transition:
      background-color var(--motion-normal) ease,
      transform var(--motion-normal) ease;
  }

  @keyframes avatar-in {
    from {
      opacity: 0;
      transform: scale(1.04);
    }
  }

  :global(.avatar-root.avatar-preview img) {
    animation: avatar-in var(--motion-normal) ease both;
  }

  .more-options summary {
    cursor: pointer;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding-block: var(--space-300);
  }

  .more-list {
    display: grid;
    gap: var(--space-300);
    padding-top: var(--space-300);
  }

  .more-list :global(.color-setting) {
    gap: var(--space-100);
  }

  .more-list :global(.color-setting > span) {
    font-size: var(--font-size-small);
  }

  .banner-setting {
    display: grid;
    gap: var(--space-150);
  }

  .banner-preview {
    aspect-ratio: 8 / 3;
    border-radius: var(--radius);
    display: block;
    object-fit: cover;
    width: 100%;
  }

  .more-options[open] .more-list {
    animation: disclosure-in var(--motion-normal) ease both;
  }

  @keyframes disclosure-in {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.avatar-root.avatar-preview),
    .more-options[open] .more-list {
      animation: none;
      transition: none;
    }
  }

  :global(html[data-reduced-motion='on'] .avatar-root.avatar-preview),
  :global(html[data-reduced-motion='on']) .more-options[open] .more-list {
    animation: none;
    transition: none;
  }
</style>
