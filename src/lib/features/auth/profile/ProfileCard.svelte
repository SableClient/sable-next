<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';

  interface Props {
    userId: string;
    displayName: string;
    avatarPreview: string | null;
    isSaving: boolean;
    error: string | null;
    onDisplayName: (value: string) => void;
    onAvatar: (file: File | null) => void;
    onContinue: () => void;
    onSkip: () => void;
  }

  let {
    userId,
    displayName,
    avatarPreview,
    isSaving,
    error,
    onDisplayName,
    onAvatar,
    onContinue,
    onSkip,
  }: Props = $props();

  let moreOpen = $state(false);
</script>

<section class="auth-card-surface" aria-labelledby="profile-title">
  <div class="auth-card-heading">
    <div>
      <p class="eyebrow">{$i18n.t('auth.nextStep')}</p>
      <h2 id="profile-title">{$i18n.t('auth.makeItYours')}</h2>
    </div>
  </div>

  <p class="intro">{$i18n.t('auth.profileIntro')}</p>
  <p class="user-id">{userId}</p>

  <div class="avatar-picker">
    <Avatar
      class="avatar-preview"
      src={avatarPreview}
      alt=""
      initials={displayName.slice(0, 1).toUpperCase() || '?'}
      size="large"
    />
    <AuthField
      fieldId="profile-avatar"
      label={$i18n.t(avatarPreview ? 'auth.replaceAvatar' : 'auth.avatar')}
    >
      <input
        id="profile-avatar"
        type="file"
        accept="image/*"
        onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
          onAvatar(event.currentTarget.files?.[0] ?? null);
        }}
      />
      {#if avatarPreview}
        <button
          class="auth-link-button remove-avatar"
          type="button"
          onclick={() => {
            onAvatar(null);
            const input = document.getElementById('profile-avatar');
            if (input instanceof HTMLInputElement) input.value = '';
          }}
        >
          {$i18n.t('auth.removeAvatar')}
        </button>
      {/if}
    </AuthField>
  </div>

  <AuthField fieldId="profile-display-name" label={$i18n.t('auth.displayName')}>
    <TextInput
      id="profile-display-name"
      value={displayName}
      autocomplete="nickname"
      maxlength={255}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onDisplayName(event.currentTarget.value);
      }}
    />
  </AuthField>

  <details class="more-options" bind:open={moreOpen}>
    <summary>{$i18n.t('auth.moreProfileOptions')}</summary>
    <div class="placeholder-list" aria-label={$i18n.t('auth.moreProfileOptions')}>
      <span>{$i18n.t('auth.nameColor')}</span>
      <span>{$i18n.t('auth.title')}</span>
      <span>{$i18n.t('auth.banner')}</span>
    </div>
  </details>

  {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

  <div class="actions">
    <Button onclick={onContinue} loading={isSaving}>
      {$i18n.t('auth.continue')}
    </Button>
    <button class="auth-link-button skip" type="button" onclick={onSkip} disabled={isSaving}>
      {$i18n.t('auth.skipForNow')}
    </button>
  </div>
</section>

<style>
  h2 {
    font-size: var(--font-size-large);
  }

  .eyebrow,
  .user-id,
  .intro {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
  }

  .user-id {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
    padding: 0.625rem 0.75rem;
  }

  .actions,
  .avatar-picker {
    display: grid;
    gap: 0.5rem;
  }

  .avatar-picker {
    align-items: center;
    gap: 0.75rem;
    grid-template-columns: auto 1fr;
  }

  :global(.sable-avatar.avatar-preview) {
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

  :global(.sable-avatar.avatar-preview img) {
    animation: avatar-in var(--motion-normal) ease both;
  }

  .more-options {
    border-top: 1px solid var(--sable-surface-container-line);
    padding-top: 0.75rem;
  }

  .more-options summary {
    color: var(--sable-sec-main);
    cursor: pointer;
    font-size: var(--font-size-small);
  }

  .placeholder-list {
    color: var(--sable-sec-main);
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    grid-template-columns: repeat(3, 1fr);
    padding-top: 0.75rem;
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
    border: 1px dashed var(--sable-surface-container-line);
    border-radius: var(--radius);
    padding: 0.625rem 0.5rem;
    text-align: center;
  }

  .skip {
    justify-self: center;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.sable-avatar.avatar-preview),
    .more-options[open] .placeholder-list {
      animation: none;
      transition: none;
    }
  }
</style>
