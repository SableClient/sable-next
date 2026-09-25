<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';
  import PasswordField from '../shared/PasswordField.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';

  interface Props {
    username?: string;
    password?: string;
    invalidField: 'username' | 'password' | null;
    fieldError: string | null;
    loginError: string | null;
    isAuthenticating: boolean;
    isCheckingHomeserver: boolean;
    resetPasswordHref: string | null;
    onClearFieldError: (field: 'username' | 'password') => void;
    onUsernameBlur?: () => void;
  }

  let {
    username = $bindable(''),
    password = $bindable(''),
    invalidField,
    fieldError,
    loginError,
    isAuthenticating,
    isCheckingHomeserver,
    resetPasswordHref,
    onClearFieldError,
    onUsernameBlur,
  }: Props = $props();

  const core = useCoreClient();
  const errorId = $props.id();
  const hintId = `${errorId}-hint`;
  let showPassword = $state(false);
  let error = $derived(
    fieldError || loginError || core.status === 'error'
      ? (fieldError ?? loginError ?? $i18n.t('auth.unableToStart'))
      : null
  );
</script>

<div class="password-form">
  <FormField dense fieldId="username" label={$i18n.t('auth.loginIdentifier')}>
    <TextInput
      id="username"
      bind:value={username}
      autocomplete="username"
      autocapitalize="off"
      spellcheck={false}
      required
      disabled={isAuthenticating || isCheckingHomeserver}
      aria-invalid={invalidField === 'username'}
      aria-describedby={error && invalidField === 'username' ? `${hintId} ${errorId}` : hintId}
      oninput={() => {
        onClearFieldError('username');
      }}
      onblur={onUsernameBlur}
    />
    <p class="username-hint" id={hintId}>{$i18n.t('auth.loginIdentifierHint')}</p>
  </FormField>
  <FormField dense fieldId="password" label={$i18n.t('auth.password')}>
    {#snippet labelSuffix()}
      {#if resetPasswordHref}
        <a class="forgot-password" href={resetPasswordHref}>{$i18n.t('auth.forgotPassword')}</a>
      {/if}
    {/snippet}
    <PasswordField
      bind:value={password}
      bind:showPassword
      disabled={isAuthenticating || isCheckingHomeserver}
      invalid={invalidField === 'password'}
      describedBy={error && invalidField === 'password' ? errorId : undefined}
      oninput={() => {
        onClearFieldError('password');
      }}
    />
  </FormField>
  <div class="submit-area">
    <AuthStatusSlot id={errorId} message={error} />
    <FormActions>
      <Button
        type="submit"
        loading={isAuthenticating}
        disabled={isCheckingHomeserver}
        variant="primary"
      >
        {isAuthenticating ? $i18n.t('auth.signingIn') : $i18n.t('auth.signInWithPassword')}</Button
      >
    </FormActions>
  </div>
</div>

<style>
  .password-form {
    display: grid;
    gap: var(--space-300);
  }

  .username-hint {
    color: var(--sec-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .forgot-password {
    color: var(--sec-main);
    font-size: var(--font-size-small);
    margin-inline-start: auto;
    text-underline-offset: 0.15em;
  }

  .forgot-password:hover {
    color: var(--sec-main-hover);
  }

  .submit-area {
    display: grid;
    gap: var(--space-200);
  }
</style>
