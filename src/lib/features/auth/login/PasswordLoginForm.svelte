<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';
  import PasswordField from '../shared/PasswordField.svelte';
  import AuthField from '../shared/AuthField.svelte';

  interface Props {
    username?: string;
    password?: string;
    invalidField: 'username' | 'password' | null;
    fieldError: string | null;
    loginError: string | null;
    isAuthenticating: boolean;
    isCheckingHomeserver: boolean;
    onClearFieldError: (field: 'username' | 'password') => void;
  }

  let {
    username = $bindable(''),
    password = $bindable(''),
    invalidField,
    fieldError,
    loginError,
    isAuthenticating,
    isCheckingHomeserver,
    onClearFieldError,
  }: Props = $props();

  const core = useCoreClient();
  const errorId = $props.id();
  let showPassword = $state(false);
  let error = $derived(
    fieldError || loginError || core.status === 'error'
      ? (fieldError ?? loginError ?? $i18n.t('auth.unableToStart'))
      : null
  );
</script>

<div class="password-form">
  <AuthField fieldId="username" label={$i18n.t('auth.username')}>
    <TextInput
      id="username"
      bind:value={username}
      autocomplete="username"
      required
      disabled={isAuthenticating || isCheckingHomeserver}
      aria-invalid={invalidField === 'username'}
      aria-describedby={error && invalidField === 'username' ? errorId : undefined}
      oninput={() => {
        onClearFieldError('username');
      }}
    />
  </AuthField>
  <AuthField fieldId="password" label={$i18n.t('auth.password')}>
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
  </AuthField>
  <div class="submit-area">
    <AuthStatusSlot id={errorId} message={error} multiline />
    <FormActions>
      <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver} variant="primary">
        {#if isAuthenticating}<Spinner />{/if}{isAuthenticating
          ? $i18n.t('auth.signingIn')
          : $i18n.t('auth.signInWithPassword')}</Button
      >
    </FormActions>
  </div>
</div>

<style>
  .password-form {
    display: grid;
    gap: var(--space-300);
  }

  .submit-area {
    display: grid;
    gap: var(--space-200);
  }
</style>
