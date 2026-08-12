<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { useCoreClient } from '$lib/core/context';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import PasswordField from '../shared/PasswordField.svelte';

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
  <div class="field">
    <Label for="username">{$i18n.t('auth.username')}</Label>
    <TextInput
      id="username"
      value={username}
      autocomplete="username"
      required
      disabled={isAuthenticating}
      aria-invalid={invalidField === 'username'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onUsernameInput(event.currentTarget.value);
        onClearFieldError('username');
      }}
    />
  </div>
  <div class="field">
    <Label for="password">{$i18n.t('auth.password')}</Label>
    <PasswordField
      value={password}
      bind:showPassword
      disabled={isAuthenticating}
      invalid={invalidField === 'password'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onPasswordInput(event.currentTarget.value);
        onClearFieldError('password');
      }}
    />
  </div>
  <div class="submit-area">
    <div class="error-slot" aria-live="polite">
      {#if fieldError || loginError || core.status === 'error'}<p class="error">
          {fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}
        </p>{/if}
    </div>
    <div class="actions">
      <Button variant="primary" type="submit" disabled={isAuthenticating || isCheckingHomeserver}
        >{#if isAuthenticating}<Spinner />{/if}{isAuthenticating
          ? $i18n.t('auth.signingIn')
          : $i18n.t('auth.signIn')}</Button
      >
    </div>
  </div>
</div>

<style>
  .actions,
  .field,
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
