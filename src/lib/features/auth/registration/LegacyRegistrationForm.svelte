<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import PasswordField from '../shared/PasswordField.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  type Field = 'username' | 'password' | 'confirmPassword' | 'email' | 'registrationToken';
  interface Props {
    serverLabel: string;
    registrationToken: string | null;
    isRegistering: boolean;
    isCheckingHomeserver: boolean;
    username: string;
    registrationEmail: string;
    password: string;
    confirmPassword: string;
    emailRequirement: 'required' | 'optional' | 'unavailable';
    tokenRequirement: 'required' | 'optional' | 'unavailable';
    invalidField: Field | 'homeserver' | null;
    fieldError: string | null;
    onRegistrationTokenInput: (value: string) => void;
    onClearFieldError: (field: Field) => void;
    onStartRegistration: () => void;
    onUsernameInput: (value: string) => void;
    onRegistrationEmailInput: (value: string) => void;
    onPasswordInput: (value: string) => void;
    onConfirmPasswordInput: (value: string) => void;
  }

  let {
    serverLabel,
    registrationToken,
    isRegistering,
    isCheckingHomeserver,
    username,
    registrationEmail,
    password,
    confirmPassword,
    emailRequirement,
    tokenRequirement,
    invalidField,
    fieldError,
    onRegistrationTokenInput,
    onClearFieldError,
    onStartRegistration,
    onUsernameInput,
    onRegistrationEmailInput,
    onPasswordInput,
    onConfirmPasswordInput,
  }: Props = $props();

  const errorId = $props.id();
  let error = $derived(fieldError && invalidField !== 'homeserver' ? fieldError : null);

  function errorFor(field: Field): string | undefined {
    return error && invalidField === field ? errorId : undefined;
  }
</script>

<form
  class="legacy-form"
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    onStartRegistration();
  }}
>
  <AuthField fieldId="registration-username" label={$i18n.t('auth.username')}>
    <TextInput
      id="registration-username"
      value={username}
      autocomplete="username"
      required
      disabled={isRegistering}
      aria-invalid={invalidField === 'username'}
      aria-describedby={errorFor('username')}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onUsernameInput(event.currentTarget.value);
        onClearFieldError('username');
      }}
    />
  </AuthField>
  <AuthField fieldId="registration-password" label={$i18n.t('auth.password')}>
    <PasswordField
      id="registration-password"
      value={password}
      disabled={isRegistering}
      autocomplete="new-password"
      invalid={invalidField === 'password'}
      describedBy={errorFor('password')}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onPasswordInput(event.currentTarget.value);
        onClearFieldError('password');
      }}
    />
  </AuthField>
  <AuthField fieldId="registration-confirm-password" label={$i18n.t('auth.confirmPassword')}>
    <PasswordField
      id="registration-confirm-password"
      value={confirmPassword}
      disabled={isRegistering}
      autocomplete="new-password"
      invalid={invalidField === 'confirmPassword'}
      describedBy={errorFor('confirmPassword')}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onConfirmPasswordInput(event.currentTarget.value);
        onClearFieldError('confirmPassword');
      }}
    />
  </AuthField>
  {#if emailRequirement !== 'unavailable'}
    <AuthField
      fieldId="registration-email"
      label={$i18n.t(emailRequirement === 'required' ? 'auth.email' : 'auth.emailOptional')}
    >
      <TextInput
        id="registration-email"
        type="email"
        value={registrationEmail}
        autocomplete="email"
        required={emailRequirement === 'required'}
        disabled={isRegistering}
        aria-invalid={invalidField === 'email'}
        aria-describedby={errorFor('email')}
        oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
          onRegistrationEmailInput(event.currentTarget.value);
          onClearFieldError('email');
        }}
      />
    </AuthField>
  {/if}
  {#if tokenRequirement !== 'unavailable'}
    <AuthField
      fieldId="registration-token"
      label={$i18n.t(
        tokenRequirement === 'required'
          ? 'auth.registrationToken'
          : 'auth.registrationTokenOptional'
      )}
    >
      {#snippet labelSuffix()}
        <Tooltip
          label={$i18n.t(
            tokenRequirement === 'required'
              ? 'auth.registrationTokenRequiredExplanation'
              : 'auth.registrationTokenOptionalExplanation'
          )}><InfoIcon /></Tooltip
        >
      {/snippet}
      <TextInput
        id="registration-token"
        value={registrationToken ?? ''}
        autocomplete="off"
        required={tokenRequirement === 'required'}
        disabled={isRegistering}
        aria-invalid={invalidField === 'registrationToken'}
        aria-describedby={errorFor('registrationToken')}
        oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
          onRegistrationTokenInput(event.currentTarget.value);
          onClearFieldError('registrationToken');
        }}
      />
    </AuthField>
  {/if}
  <div class="submit-area">
    <AuthStatusSlot id={errorId} message={error} />
    <FormActions>
      <Button
        type="submit"
        loading={isRegistering}
        disabled={isCheckingHomeserver}
        variant="primary"
      >
        {$i18n.t('auth.createServerAccount', { server: serverLabel })}
      </Button>
    </FormActions>
  </div>
</form>

<style>
  .legacy-form {
    display: grid;
    gap: var(--space-300);
  }

  .submit-area {
    display: grid;
    gap: var(--space-200);
  }
</style>
