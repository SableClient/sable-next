<script lang="ts">
  import { i18n } from '$lib/i18n';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import type { RegistrationFlowsView } from '@/generated/RegistrationFlowsView';
  import type { RegistrationResultView } from '@/generated/RegistrationResultView';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import Label from '$lib/ui/primitives/Label.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
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
    onEditHomeserver: () => void;
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
    onEditHomeserver,
    onUsernameInput,
    onRegistrationEmailInput,
    onPasswordInput,
    onConfirmPasswordInput,
  }: Props = $props();
</script>

<section class="auth-card-surface" aria-labelledby="registration-title">
  <div class="auth-card-heading centered">
    <div>
      <h2 id="registration-title">{$i18n.t('auth.createAccount')}</h2>
    </div>
  </div>

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
    <div class="provider-row">
      <div class="provider-mark" aria-hidden="true"><GlobeIcon /></div>
      <span class="provider-name">
        {$i18n.t('auth.registerWith', { server: homeserver || 'matrix.org' })}
      </span>
    </div>

    {#if isEditingHomeserver}
      <div class="field">
        <Label for="registration-homeserver">{$i18n.t('auth.accountProvider')}</Label>
        <HomeserverPicker
          id="registration-homeserver"
          value={homeserver}
          disabled={isRegistering || isCheckingHomeserver}
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
      </div>
    {:else}
      <button class="edit-server" type="button" onclick={onEditHomeserver}>
        {$i18n.t('auth.chooseDifferentServer')}
      </button>
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
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    gap: 0.625rem;
    padding: 0.625rem;
  }

  .provider-mark {
    align-items: center;
    background: var(--sable-primary-container);
    border-radius: 50%;
    color: var(--sable-primary-on-container);
    display: flex;
    flex: 0 0 2rem;
    height: 2rem;
    justify-content: center;
    width: 2rem;
  }

  .provider-mark :global(svg) {
    height: 1.25rem;
    width: 1.25rem;
  }

  .provider-name {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .field {
    display: grid;
    gap: 0.5rem;
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
    height: 1.5rem;
    overflow: hidden;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .edit-server {
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    justify-self: start;
    padding: 0;
    text-decoration: underline;
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
