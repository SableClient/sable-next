<script lang="ts">
  import { fade } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import Button from '$lib/ui/primitives/Button.svelte';
  import AuthMethodToggle from '../shared/AuthMethodToggle.svelte';
  import LoginMethod from './LoginMethod.svelte';
  import PasswordLoginForm from './PasswordLoginForm.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import HomeserverPicker from '../shared/HomeserverPicker.svelte';
  import AuthField from '../shared/AuthField.svelte';

  type LoginField = 'homeserver' | 'username' | 'password';
  type LoginMethodType = 'oidc' | 'sso';
  interface Props {
    homeserver?: string;
    username?: string;
    password?: string;
    loginFlows: LoginFlowsView | null;
    invalidField: LoginField | null;
    fieldError: string | null;
    loginError: string | null;
    isCheckingHomeserver: boolean;
    isLaunchingLogin: boolean;
    onClearHomeserverValidation: () => void;
    onValidateHomeserver: () => Promise<LoginFlowsView | null>;
    onClearFieldError: (field: Exclude<LoginField, 'homeserver'>) => void;
    onLaunchRedirectLogin: (
      loginType: LoginMethodType,
      identityProviderId?: string
    ) => Promise<void>;
    onLogin: () => Promise<void>;
    onCreateAccount?: () => void;
  }

  let {
    homeserver = $bindable(''),
    username = $bindable(''),
    password = $bindable(''),
    loginFlows,
    invalidField,
    fieldError,
    loginError,
    isCheckingHomeserver,
    isLaunchingLogin,
    onClearHomeserverValidation,
    onValidateHomeserver,
    onClearFieldError,
    onLaunchRedirectLogin,
    onLogin,
    onCreateAccount,
  }: Props = $props();

  const core = useCoreClient();
  let isAuthenticating = $derived(core.status === 'authenticating');
  let showAllLoginMethods = $state(false);
  let displayedHomeserver = $state(homeserver);
  let isLoginControlsDisabled = $derived(
    isCheckingHomeserver || homeserver !== displayedHomeserver
  );

  const loginMethodOrder: Array<'oidc' | 'sso' | 'password'> = ['oidc', 'sso', 'password'];
  let preferredLoginMethod = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return null;
    if (flows.oauth_aware_preferred && flows.oidc) return 'oidc';
    return loginMethodOrder.find((method) => flows[method]) ?? null;
  });
  let availableLoginMethodCount = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return 0;
    return loginMethodOrder.filter((method) => flows[method]).length;
  });
  let isPasswordLoginVisible = $derived(
    loginFlows?.password === true && (showAllLoginMethods || preferredLoginMethod === 'password')
  );
  let hasLoginAction = $derived(loginFlows === null || preferredLoginMethod !== null);
  let statusError = $derived(
    !isPasswordLoginVisible && (fieldError || loginError || core.status === 'error')
      ? (fieldError ?? loginError ?? $i18n.t('auth.unableToStart'))
      : null
  );

  const methodSlotId = $props.id();
  // A combobox pick and the blur it causes both validate, so only the latest
  // answer may release the controls.
  let latestValidation = 0;

  async function validateHomeserver(): Promise<LoginFlowsView | null> {
    const validation = ++latestValidation;
    const flows = await onValidateHomeserver();
    if (flows && validation === latestValidation) {
      displayedHomeserver = homeserver;
      showAllLoginMethods = false;
    }
    return flows;
  }
</script>

<form
  class="login-form auth-card-surface"
  out:fade={{ duration: prefersReducedMotion.current ? 0 : 200 }}
  aria-busy={isAuthenticating}
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    void onLogin();
  }}
>
  <AuthField fieldId="homeserver" label={$i18n.t('auth.accountProvider')}>
    <HomeserverPicker
      id="homeserver"
      bind:value={homeserver}
      disabled={isAuthenticating}
      required
      ariaInvalid={invalidField === 'homeserver'}
      oninput={onClearHomeserverValidation}
      onvaluechange={(selectedHomeserver: string) => {
        homeserver = selectedHomeserver;
        onClearHomeserverValidation();
        void validateHomeserver();
      }}
      onblur={() => void validateHomeserver()}
    />
  </AuthField>

  <div class="status-slot" aria-live="polite">
    {#if isCheckingHomeserver}
      <div class="status-message checking">
        <Spinner small />
        {$i18n.t('auth.checkingProvider')}
      </div>
    {:else if statusError}
      <p class="status-message error" role="alert" title={statusError}>{statusError}</p>
    {:else if loginFlows && availableLoginMethodCount === 0}
      <p class="status-message muted">{$i18n.t('errors.unsupportedSignIn')}</p>
    {/if}
  </div>

  <div class="login-methods">
    <div class="method-slot" class:action-slot={hasLoginAction} id={methodSlotId}>
      {#if !loginFlows}
        <div class="actions">
          <Button
            type="submit"
            disabled={isAuthenticating || isLoginControlsDisabled}
            variant="primary"
          >
            {isCheckingHomeserver ? $i18n.t('auth.checking') : $i18n.t('auth.continue')}
          </Button>
        </div>
      {/if}

      {#if loginFlows?.oidc && (showAllLoginMethods || preferredLoginMethod === 'oidc')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          <div class="actions">
            <Button
              disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
              onclick={() => void onLaunchRedirectLogin('oidc')}
              variant="primary"
            >
              {isLaunchingLogin
                ? $i18n.t('auth.opening')
                : $i18n.t('auth.signInWithProvider', {
                    name: displayedHomeserver || 'matrix.org',
                  })}
            </Button>
          </div>
        </LoginMethod>
      {/if}

      {#if loginFlows?.sso && (showAllLoginMethods || preferredLoginMethod === 'sso')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          {#if loginFlows.sso_identity_providers.length > 0}
            <div class="actions sso-actions">
              {#each loginFlows.sso_identity_providers as provider (provider.id)}
                <Button
                  disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
                  onclick={() => void onLaunchRedirectLogin('sso', provider.id)}
                  variant="primary"
                >
                  {$i18n.t('auth.signInWithProvider', { name: provider.name })}
                </Button>
              {/each}
            </div>
          {:else}
            <div class="actions">
              <Button
                disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
                onclick={() => void onLaunchRedirectLogin('sso')}
                variant="primary"
              >
                {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithSso')}
              </Button>
            </div>
          {/if}
        </LoginMethod>
      {/if}

      {#if loginFlows?.password && (showAllLoginMethods || preferredLoginMethod === 'password')}
        <LoginMethod reducedMotion={prefersReducedMotion.current}>
          <PasswordLoginForm
            {username}
            {password}
            invalidField={invalidField === 'homeserver' ? null : invalidField}
            {fieldError}
            {loginError}
            {isAuthenticating}
            isCheckingHomeserver={isLoginControlsDisabled}
            onUsernameInput={(value: string) => {
              username = value;
            }}
            onPasswordInput={(value: string) => {
              password = value;
            }}
            {onClearFieldError}
          />
        </LoginMethod>
      {/if}
    </div>

    {#if availableLoginMethodCount > 1}
      <AuthMethodToggle
        expanded={showAllLoginMethods}
        controls={methodSlotId}
        showLabel={$i18n.t('auth.moreWaysToSignIn')}
        hideLabel={$i18n.t('auth.hideOtherWaysToSignIn')}
        disabled={isLoginControlsDisabled}
        onToggle={() => {
          showAllLoginMethods = !showAllLoginMethods;
        }}
      />
    {/if}
  </div>
</form>

{#if onCreateAccount}
  <div class="account-switch">
    <span>{$i18n.t('auth.newToMatrixQuestion')}</span>
    <button
      class="account-switch-button"
      type="button"
      disabled={isLoginControlsDisabled}
      onclick={onCreateAccount}
    >
      {$i18n.t('auth.createAccount')}
    </button>
  </div>
{/if}

<style>
  .actions {
    display: grid;
  }

  .account-switch {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: 0.25rem;
    justify-content: center;
    padding-top: 0.5rem;
    text-align: center;
  }

  .account-switch-button {
    background: transparent;
    border: 0;
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-bold);
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
    transition:
      color var(--motion-normal) var(--motion-easing-standard),
      text-decoration-color var(--motion-normal) var(--motion-easing-standard);
  }

  .account-switch-button:hover {
    color: var(--sable-primary-main-hover);
  }

  .account-switch-button:focus-visible {
    border-radius: 0.125rem;
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.15rem;
  }

  .account-switch-button:disabled {
    cursor: default;
    opacity: 0.55;
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

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .muted {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .status-message {
    margin: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-message.error,
  .status-message.muted {
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

  @keyframes error-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  .login-form {
    min-width: 0;
  }

  .login-methods {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .method-slot {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .method-slot:not(.action-slot) {
    display: none;
  }

  .action-slot {
    min-height: 2.75rem;
  }

  .sso-actions {
    gap: 0.75rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .error {
      animation: error-in var(--motion-normal) ease-out;
    }
  }
</style>
