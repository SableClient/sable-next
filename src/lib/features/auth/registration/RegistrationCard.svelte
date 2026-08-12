<script lang="ts">
  import { i18n } from '$lib/i18n';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import type { RegistrationFlowsView } from '@/generated/RegistrationFlowsView';
  import type { RegistrationResultView } from '@/generated/RegistrationResultView';
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import Tooltip from '$lib/ui/primitives/Tooltip.svelte';
  import AuthField from '../shared/AuthField.svelte';
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

<section class="registration-card auth-card-surface" aria-labelledby="registration-title">
  <AuthField labelId="registration-title" label={$i18n.t('auth.createAccount')}>
    {#if !fallback && !emailStep}
      <div class="provider-row">
        <span class="provider-name">
          <!-- mustache required so formatter doesn't delete the space -->
          <!-- eslint-disable-next-line svelte/no-useless-mustaches -->
          {$i18n.t('auth.registeringWith')}{' '}
          <Tooltip class="provider-tooltip" label={$i18n.t('auth.changeProviderHint')}>
            {homeserver || 'matrix.org'}
          </Tooltip>
        </span>
        <Tooltip class="provider-info-tooltip" label={$i18n.t('auth.accountProviderHint')}
          ><InfoIcon /></Tooltip
        >
      </div>
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

    <div class="status-slot" aria-live="polite">
      {#if isCheckingHomeserver}
        <div class="status-message checking">
          <Spinner small />
          {$i18n.t('auth.checkingProvider')}
        </div>
      {:else if invalidRegistrationField === 'homeserver' && registrationFieldError}
        <p class="status-message error" title={registrationFieldError}>{registrationFieldError}</p>
      {:else if error && !registrationFieldError}
        <p class="status-message error" title={error}>{error}</p>
      {/if}
    </div>

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
  .provider-row {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    gap: 0.625rem;
    min-height: 2.75rem;
    padding: 0.625rem 0.875rem;
  }

  .provider-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  :global(.tooltip-trigger.provider-info-tooltip svg) {
    height: 1.125rem;
    width: 1.125rem;
  }

  :global(.tooltip-trigger.provider-tooltip) {
    align-items: baseline;
    background: transparent;
    border-radius: 0.125rem;
    color: inherit;
    cursor: default;
    display: inline;
    font: inherit;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  :global(.tooltip-trigger.provider-tooltip:hover),
  :global(.tooltip-trigger.provider-tooltip[data-state='open']) {
    background: transparent;
    color: var(--sable-bg-on-container);
  }

  :global(.tooltip-trigger.provider-tooltip:focus-visible) {
    box-shadow: 0 0 0 0.2rem var(--sable-focus-ring);
    outline: none;
  }

  .checking {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    line-height: var(--line-height-body);
    margin: 0;
  }

  .status-message {
    margin: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-message.error {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .status-slot {
    align-items: center;
    display: flex;
    height: calc(var(--font-size-small) * var(--line-height-body));
    overflow: hidden;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  @keyframes error-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .error {
      animation: error-in var(--motion-normal) ease-out;
    }
  }
</style>
