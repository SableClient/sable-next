<script lang="ts">
  import CameraIcon from 'phosphor-svelte/lib/CameraIcon';

  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';

  interface Props {
    userId: string;
    displayName: string;
    pronouns: string;
    avatarPreview: string | null;
    isSaving: boolean;
    error: string | null;
    onDisplayName: (value: string) => void;
    onPronouns: (value: string) => void;
    onAvatar: (file: File | null) => void;
    onContinue: () => void;
    onSkip: () => void;
  }

  let {
    userId,
    displayName,
    pronouns,
    avatarPreview,
    isSaving,
    error,
    onDisplayName,
    onPronouns,
    onAvatar,
    onContinue,
    onSkip,
  }: Props = $props();

  let moreOpen = $state(false);
</script>

<section class="profile-card auth-card-surface" aria-labelledby="profile-title">
  <div class="auth-card-heading">
    <div>
      <p class="eyebrow">{$i18n.t('auth.nextStep')}</p>
      <h2 id="profile-title">{$i18n.t('auth.makeItYours')}</h2>
    </div>
  </div>

  <p class="intro">{$i18n.t('auth.profileIntro')}</p>
  <p class="user-id">{userId}</p>

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
    <div class="placeholder-list" aria-label={$i18n.t('auth.moreProfileOptions')}>
      <span>{$i18n.t('auth.nameColor')}</span>
      <span>{$i18n.t('auth.title')}</span>
      <span>{$i18n.t('auth.banner')}</span>
    </div>
  </details>

  {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

  <Button variant="primary" block onclick={onContinue} loading={isSaving}>
    {$i18n.t('auth.continue')}
  </Button>
</section>

<AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} disabled={isSaving} />

<style>
  .profile-card {
    min-width: 0;
  }

  h2 {
    font-size: var(--font-size-heading);
  }

  .user-id,
  .intro {
    color: var(--sec-main);
    font-size: var(--font-size-small);
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

  .more-options {
    border-top: var(--border-width) solid var(--surface-container-line);
    padding-top: var(--space-300);
  }

  .more-options summary {
    color: var(--sec-main);
    cursor: pointer;
    font-size: var(--font-size-small);
  }

  .placeholder-list {
    color: var(--sec-main);
    display: grid;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    grid-template-columns: repeat(3, 1fr);
    padding-top: var(--space-300);
  }

  .more-options[open] .placeholder-list {
    animation: disclosure-in var(--motion-normal) ease both;
  }

  @keyframes disclosure-in {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
  }

  .placeholder-list span {
    border: var(--border-width) dashed var(--surface-container-line);
    border-radius: var(--radius);
    padding: var(--space-250) var(--space-200);
    text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.avatar-root.avatar-preview),
    .more-options[open] .placeholder-list {
      animation: none;
      transition: none;
    }
  }

  :global(html[data-reduced-motion='on'] .avatar-root.avatar-preview),
  :global(html[data-reduced-motion='on']) .more-options[open] .placeholder-list {
    animation: none;
    transition: none;
  }
</style>
