<script lang="ts">
  import { prefersReducedMotion } from 'svelte/motion';
  import { i18n } from '#lib/i18n.js';
  import type { LoginFlowsView } from '#src/generated/LoginFlowsView';
  import type { RegistrationFlowsView } from '#src/generated/RegistrationFlowsView';
  import Button from '#lib/ui/primitives/Button.svelte';
  import AuthMethodToggle from '../shared/AuthMethodToggle.svelte';
  import LoginMethod from '../login/LoginMethod.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import LegacyRegistrationForm from './LegacyRegistrationForm.svelte';
  import { REGISTRATION_METHOD_ORDER, registrationMethodAvailable } from './registration-methods';

  type RegistrationField =
    | 'homeserver'
    | 'username'
    | 'password'
    | 'confirmPassword'
    | 'email'
    | 'registrationToken';

  interface Props {
    homeserver: string;
    registrationToken: string | null;
    loginFlows: LoginFlowsView | null;
    registrationFlows: RegistrationFlowsView | null;
    isCheckingHomeserver: boolean;
    isRegistering: boolean;
    username: string;
    registrationEmail: string;
    password: string;
    confirmPassword: string;
    onRegistrationTokenInput: (value: string) => void;
    invalidField: RegistrationField | null;
    fieldError: string | null;
    onClearFieldError: (field: Exclude<RegistrationField, 'homeserver'>) => void;
    onStartRegistration: () => void;
    onLaunchRedirectLogin: (type: 'oidc' | 'sso', id?: string) => void;
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
    username,
    registrationEmail,
    password,
    confirmPassword,
    onRegistrationTokenInput,
    invalidField,
    fieldError,
    onClearFieldError,
    onStartRegistration,
    onLaunchRedirectLogin,
    onUsernameInput,
    onRegistrationEmailInput,
    onPasswordInput,
    onConfirmPasswordInput,
  }: Props = $props();

  const methodSlotId = $props.id();
  let showAllRegistrationMethods = $state(false);
  let observedHomeserver = $state('');

  $effect(() => {
    if (homeserver === observedHomeserver) return;
    observedHomeserver = homeserver;
    showAllRegistrationMethods = false;
  });

  let availableRegistrationMethodCount = $derived.by(() => {
    if (!loginFlows) return 0;
    return REGISTRATION_METHOD_ORDER.filter((method) =>
      registrationMethodAvailable(loginFlows, method, registrationFlows?.uiaa === true)
    ).length;
  });
  let firstAvailableRegistrationMethod = $derived.by(() => {
    if (!loginFlows) return null;
    return (
      REGISTRATION_METHOD_ORDER.find((method) =>
        registrationMethodAvailable(loginFlows, method, registrationFlows?.uiaa === true)
      ) ?? null
    );
  });
  let emailRequirement = $derived(registrationFlows?.email ?? 'unavailable');
  let tokenRequirement = $derived(registrationFlows?.registration_token ?? 'unavailable');
  let serverLabel = $derived(homeserver || 'matrix.org');
</script>

<div class="registration-methods">
  {#if availableRegistrationMethodCount > 0}
    <div class="method-slot" id={methodSlotId}>
      {#if loginFlows && registrationMethodAvailable(loginFlows, 'oidc', registrationFlows?.uiaa === true) && (showAllRegistrationMethods || firstAvailableRegistrationMethod === 'oidc')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          <Button
            disabled={isRegistering || isCheckingHomeserver}
            onclick={() => {
              onLaunchRedirectLogin('oidc');
            }}
            variant="primary"
          >
            {#if isRegistering}<Spinner />{/if}
            {$i18n.t('auth.createAccountOnServer', { server: serverLabel })}
          </Button>
        </LoginMethod>
      {/if}

      {#if loginFlows && registrationMethodAvailable(loginFlows, 'sso', registrationFlows?.uiaa === true) && (showAllRegistrationMethods || firstAvailableRegistrationMethod === 'sso')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          <div class="actions">
            {#if loginFlows.sso_identity_providers.length > 0}
              {#each loginFlows.sso_identity_providers as provider (provider.id)}
                <Button
                  disabled={isRegistering}
                  onclick={() => {
                    onLaunchRedirectLogin('sso', provider.id);
                  }}
                  variant="primary"
                >
                  {$i18n.t('auth.continueWithProvider', { name: provider.name })}
                </Button>
              {/each}
            {:else}
              <Button
                disabled={isRegistering}
                onclick={() => {
                  onLaunchRedirectLogin('sso');
                }}
                variant="primary"
              >
                {$i18n.t('auth.createAccountOnServer', { server: serverLabel })}
              </Button>
            {/if}
          </div>
        </LoginMethod>
      {/if}

      {#if loginFlows && registrationFlows?.uiaa && (showAllRegistrationMethods || firstAvailableRegistrationMethod === 'password')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          <LegacyRegistrationForm
            {serverLabel}
            {registrationToken}
            {isRegistering}
            {isCheckingHomeserver}
            {username}
            {registrationEmail}
            {password}
            {confirmPassword}
            {emailRequirement}
            {tokenRequirement}
            {invalidField}
            {fieldError}
            {onRegistrationTokenInput}
            {onClearFieldError}
            {onStartRegistration}
            {onUsernameInput}
            {onRegistrationEmailInput}
            {onPasswordInput}
            {onConfirmPasswordInput}
          />
        </LoginMethod>
      {/if}
    </div>
  {/if}

  {#if availableRegistrationMethodCount > 1}
    <AuthMethodToggle
      expanded={showAllRegistrationMethods}
      controls={methodSlotId}
      showLabel={$i18n.t('auth.moreWaysToCreateAccount')}
      hideLabel={$i18n.t('auth.hideOtherWaysToCreateAccount')}
      onToggle={() => {
        showAllRegistrationMethods = !showAllRegistrationMethods;
      }}
    />
  {/if}

  {#if availableRegistrationMethodCount === 0 && !isCheckingHomeserver}
    <p class="muted">{$i18n.t('errors.registrationUnavailable')}</p>
  {/if}
</div>

<style>
  .registration-methods {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .method-slot {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .actions {
    display: grid;
    gap: 0.75rem;
  }

  .muted {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }
</style>
