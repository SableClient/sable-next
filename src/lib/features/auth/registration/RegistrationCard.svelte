<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { LoginFlowsView } from '#src/generated/LoginFlowsView';
  import type { RegistrationFlowsView } from '#src/generated/RegistrationFlowsView';
  import type { RegistrationResultView } from '#src/generated/RegistrationResultView';
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';
  import { homeservers } from '../shared/homeservers.svelte.js';
  import HomeserverPicker from '../shared/HomeserverPicker.svelte';
  import RegistrationBrowserStep from './RegistrationBrowserStep.svelte';
  import RegistrationMethods from './RegistrationMethods.svelte';

  interface Props {
    homeserver: string;
    registrationToken: string | null;
    loginFlows: LoginFlowsView | null;
    registrationFlows: RegistrationFlowsView | null;
    isCheckingHomeserver: boolean;
    isRegistering: boolean;
    isEditingHomeserver: boolean;
    fallback: Extract<RegistrationResultView, { state: 'fallback' }> | null;
    emailStep: Extract<RegistrationResultView, { state: 'email' }> | null;
    username: string;
    registrationEmail: string;
    password: string;
    confirmPassword: string;
    error: string | null;
    invalidRegistrationField:
      | 'homeserver'
      | 'username'
      | 'password'
      | 'confirmPassword'
      | 'email'
      | 'registrationToken'
      | null;
    registrationFieldError: string | null;
    onHomeserverInput: (value: string) => void;
    onRegistrationTokenInput: (value: string) => void;
    onValidateHomeserver: () => void;
    onClearFieldError: (
      field: 'username' | 'password' | 'confirmPassword' | 'email' | 'registrationToken'
    ) => void;
    onStartRegistration: () => void;
    onLaunchRedirectLogin: (type: 'oidc' | 'sso', id?: string) => void;
    onOpenFallback: () => void;
    onContinueFallback: () => void;
    onRequestRegistrationEmail: (email: string) => void;
    onSubmitRegistrationEmail: (token: string) => void;
    onUsernameInput: (value: string) => void;
    onRegistrationEmailInput: (value: string) => void;
    onPasswordInput: (value: string) => void;
    onConfirmPasswordInput: (value: string) => void;
  }

  let {
    homeserver,
    registrationToken,
    loginFlows,
    registrationFlows,
    isCheckingHomeserver,
    isRegistering,
    isEditingHomeserver,
    fallback,
    emailStep,
    username,
    registrationEmail,
    password,
    confirmPassword,
    error,
    invalidRegistrationField,
    registrationFieldError,
    onHomeserverInput,
    onRegistrationTokenInput,
    onValidateHomeserver,
    onClearFieldError,
    onStartRegistration,
    onLaunchRedirectLogin,
    onOpenFallback,
    onContinueFallback,
    onRequestRegistrationEmail,
    onSubmitRegistrationEmail,
    onUsernameInput,
    onRegistrationEmailInput,
    onPasswordInput,
    onConfirmPasswordInput,
  }: Props = $props();
</script>

{#snippet accountProviderInfo()}
  <Tooltip variant="icon" label={$i18n.t('auth.accountProviderHint')}><InfoIcon /></Tooltip>
{/snippet}

<section class="registration-card auth-card-surface" aria-labelledby="registration-title">
  <AuthField labelId="registration-title" label={$i18n.t('auth.createAccount')}>
    {#if !fallback && !emailStep}
      <AuthInfoBox trailing={accountProviderInfo}>
        <span class="provider-name">
          <!-- mustache required so formatter doesn't delete the space -->
          <!-- eslint-disable-next-line svelte/no-useless-mustaches -->
          {$i18n.t('auth.registeringWith')}{' '}
          <Tooltip variant="inline" label={$i18n.t('auth.changeProviderHint')}>
            {homeserver || homeservers.default}
          </Tooltip>
        </span>
      </AuthInfoBox>
    {/if}
  </AuthField>

  {#if fallback || emailStep}
    <RegistrationBrowserStep
      {homeserver}
      {isRegistering}
      {fallback}
      {emailStep}
      {onOpenFallback}
      {onContinueFallback}
      {onRequestRegistrationEmail}
      {onSubmitRegistrationEmail}
    />
  {:else}
    {#if isEditingHomeserver}
      <AuthField fieldId="registration-homeserver" label={$i18n.t('auth.accountProvider')}>
        <HomeserverPicker
          id="registration-homeserver"
          value={homeserver}
          disabled={isRegistering}
          ariaInvalid={invalidRegistrationField === 'homeserver'}
          oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
            onHomeserverInput(event.currentTarget.value);
          }}
          onvaluechange={(value: string) => {
            onHomeserverInput(value);
            onValidateHomeserver();
          }}
          onblur={onValidateHomeserver}
        />
      </AuthField>
    {/if}

    <AuthStatusSlot
      loading={isCheckingHomeserver}
      loadingMessage={$i18n.t('auth.checkingProvider')}
      message={invalidRegistrationField === 'homeserver' && registrationFieldError
        ? registrationFieldError
        : error && !registrationFieldError
          ? error
          : null}
      multiline
    />

    <RegistrationMethods
      {homeserver}
      {registrationToken}
      {loginFlows}
      {registrationFlows}
      {isCheckingHomeserver}
      {isRegistering}
      {username}
      {registrationEmail}
      {password}
      {confirmPassword}
      {onRegistrationTokenInput}
      invalidField={invalidRegistrationField}
      fieldError={registrationFieldError}
      {onClearFieldError}
      {onStartRegistration}
      {onLaunchRedirectLogin}
      {onUsernameInput}
      {onRegistrationEmailInput}
      {onPasswordInput}
      {onConfirmPasswordInput}
    />
  {/if}
</section>

<style>
  .provider-name {
    overflow-wrap: anywhere;
  }
</style>
