<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import InfoIcon from 'phosphor-icons-svelte/IconInfoRegular.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import Tooltip from '$lib/ui/primitives/Tooltip.svelte';
  import PasswordField from '../shared/PasswordField.svelte';

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
</script>

<form
  class="legacy-form"
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    onStartRegistration();
  }}
>
  <div class="field">
    <Label for="registration-username">{$i18n.t('auth.username')}</Label>
    <TextInput
      id="registration-username"
      value={username}
      autocomplete="username"
      required
      disabled={isRegistering}
      aria-invalid={invalidField === 'username'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onUsernameInput(event.currentTarget.value);
        onClearFieldError('username');
      }}
    />
  </div>
  <div class="field">
    <Label for="registration-password">{$i18n.t('auth.password')}</Label>
    <PasswordField
      id="registration-password"
      value={password}
      disabled={isRegistering}
      autocomplete="new-password"
      invalid={invalidField === 'password'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onPasswordInput(event.currentTarget.value);
        onClearFieldError('password');
      }}
    />
  </div>
  <div class="field">
    <Label for="registration-confirm-password">{$i18n.t('auth.confirmPassword')}</Label>
    <PasswordField
      id="registration-confirm-password"
      value={confirmPassword}
      disabled={isRegistering}
      autocomplete="new-password"
      invalid={invalidField === 'confirmPassword'}
      oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
        onConfirmPasswordInput(event.currentTarget.value);
        onClearFieldError('confirmPassword');
      }}
    />
  </div>
  {#if emailRequirement !== 'unavailable'}
    <div class="field">
      <Label for="registration-email"
        >{$i18n.t(emailRequirement === 'required' ? 'auth.email' : 'auth.emailOptional')}</Label
      >
      <TextInput
        id="registration-email"
        type="email"
        value={registrationEmail}
        autocomplete="email"
        required={emailRequirement === 'required'}
        disabled={isRegistering}
        aria-invalid={invalidField === 'email'}
        oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
          onRegistrationEmailInput(event.currentTarget.value);
          onClearFieldError('email');
        }}
      />
    </div>
  {/if}
  {#if tokenRequirement !== 'unavailable'}
    <div class="field">
      <div class="field-label">
        <Label for="registration-token"
          >{$i18n.t(
            tokenRequirement === 'required'
              ? 'auth.registrationToken'
              : 'auth.registrationTokenOptional'
          )}</Label
        >
        <Tooltip
          label={$i18n.t(
            tokenRequirement === 'required'
              ? 'auth.registrationTokenRequiredExplanation'
              : 'auth.registrationTokenOptionalExplanation'
          )}><InfoIcon /></Tooltip
        >
      </div>
      <TextInput
        id="registration-token"
        value={registrationToken ?? ''}
        autocomplete="off"
        required={tokenRequirement === 'required'}
        disabled={isRegistering}
        aria-invalid={invalidField === 'registrationToken'}
        oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
          onRegistrationTokenInput(event.currentTarget.value);
          onClearFieldError('registrationToken');
        }}
      />
    </div>
  {/if}
  <div class="submit-area">
    <div class="error-slot" aria-live="polite">
      {#if fieldError && invalidField !== 'homeserver'}<p class="error">{fieldError}</p>{/if}
    </div>
    <div class="actions">
      <Button type="submit" disabled={isRegistering || isCheckingHomeserver}
        >{#if isRegistering}<Spinner />{/if}{$i18n.t('auth.createServerAccount', {
          server: serverLabel,
        })}</Button
      >
    </div>
  </div>
</form>

<style>
  .actions,
  .field,
  .legacy-form {
    display: grid;
    gap: 0.75rem;
  }

  .field-label {
    align-items: center;
    display: flex;
    gap: 0.375rem;
  }

  .field-label :global(.tooltip-trigger svg) {
    height: 1.25rem;
    width: 1.25rem;
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

  .submit-area {
    display: grid;
    gap: 0.5rem;
  }
</style>
