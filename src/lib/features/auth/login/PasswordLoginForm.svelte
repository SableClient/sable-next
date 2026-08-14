<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { useCoreClient } from '$lib/core/context';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import PasswordField from '../shared/PasswordField.svelte';
  import AuthField from '../shared/AuthField.svelte';

  interface Props {
    username: string;
    password: string;
    invalidField: 'username' | 'password' | null;
    fieldError: string | null;
    loginError: string | null;
    isAuthenticating: boolean;
    isCheckingHomeserver: boolean;
    onUsernameInput: (value: string) => void;
    onPasswordInput: (value: string) => void;
    onClearFieldError: (field: 'username' | 'password') => void;
  }

  let {
    username,
    password,
    invalidField,
    fieldError,
    loginError,
    isAuthenticating,
    isCheckingHomeserver,
    onUsernameInput,
    onPasswordInput,
    onClearFieldError,
  }: Props = $props();

  const core = useCoreClient();
  let showPassword = $state(false);
</script>

<div class="password-form">
  <AuthField fieldId="username" label={$i18n.t('auth.username')}>
    <TextInput
      id="username"
      value={username}
      autocomplete="username"
      required
      disabled={isAuthenticating || isCheckingHomeserver}
      aria-invalid={invalidField === 'username'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onUsernameInput(event.currentTarget.value);
        onClearFieldError('username');
      }}
    />
  </AuthField>
  <AuthField fieldId="password" label={$i18n.t('auth.password')}>
    <PasswordField
      value={password}
      bind:showPassword
      disabled={isAuthenticating || isCheckingHomeserver}
      invalid={invalidField === 'password'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onPasswordInput(event.currentTarget.value);
        onClearFieldError('password');
      }}
    />
  </AuthField>
  <div class="submit-area">
    <div class="error-slot" aria-live="polite">
      {#if fieldError || loginError || core.status === 'error'}<p class="error">
          {fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}
        </p>{/if}
    </div>
    <div class="actions">
      <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver} variant="primary">
        {#if isAuthenticating}<Spinner />{/if}{isAuthenticating
          ? $i18n.t('auth.signingIn')
          : $i18n.t('auth.signInWithPassword')}</Button
      >
    </div>
  </div>
</div>

<style>
  .actions,
  .password-form {
    display: grid;
    gap: 0.75rem;
  }

  .submit-area {
    display: grid;
    gap: 0.5rem;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .error-slot {
    min-height: calc(var(--font-size-small) * var(--line-height-body));
  }
</style>
