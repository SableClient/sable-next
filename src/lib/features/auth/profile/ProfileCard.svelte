<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';

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
    <Avatar class="avatar-preview" src={avatarPreview} alt="" name={displayName} size="large" />
    <FormField
      dense
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
    </FormField>
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

  <details class="more-options" bind:open={moreOpen}>
    <summary>{$i18n.t('auth.moreProfileOptions')}</summary>
    <div class="placeholder-list" aria-label={$i18n.t('auth.moreProfileOptions')}>
      <span>{$i18n.t('auth.nameColor')}</span>
      <span>{$i18n.t('auth.title')}</span>
      <span>{$i18n.t('auth.banner')}</span>
    </div>
  </details>

  {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

  <FormActions>
    <Button onclick={onContinue} loading={isSaving}>
      {$i18n.t('auth.continue')}
    </Button>
    <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} disabled={isSaving} />
  </FormActions>
</section>

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

  .avatar-picker input[type='file'] {
    max-width: 100%;
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
