<script lang="ts">
  import { fade } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import AuthMethodToggle from '../shared/AuthMethodToggle.svelte';
  import LoginMethod from './LoginMethod.svelte';
  import PasswordLoginForm from './PasswordLoginForm.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import { smoothSlide } from '../flow/login-transitions';
  import HomeserverPicker from '../shared/HomeserverPicker.svelte';

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
  let observedHomeserver = homeserver;

  $effect(() => {
    if (homeserver === observedHomeserver) return;
    observedHomeserver = homeserver;
    showAllLoginMethods = false;
  });

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
  let firstAvailableLoginMethod = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return null;
    return loginMethodOrder.find((method) => flows[method]) ?? null;
  });
  let isPasswordLoginVisible = $derived(
    loginFlows?.password === true && (showAllLoginMethods || preferredLoginMethod === 'password')
  );
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
  <div class="auth-card-heading centered">
    <div>
      <h2>{$i18n.t('auth.signInTitle')}</h2>
    </div>
  </div>

  <div class="field">
    <Label for="homeserver">{$i18n.t('auth.homeserver')}</Label>
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
        void onValidateHomeserver();
      }}
      onblur={() => void onValidateHomeserver()}
    />
    <p class:checking-active={isCheckingHomeserver} class="checking" aria-live="polite">
      {#if isCheckingHomeserver}
        <Spinner small />
        {$i18n.t('auth.checkingHomeserver')}
      {/if}
    </p>
  </div>

  {#if loginFlows?.oidc && (showAllLoginMethods || preferredLoginMethod === 'oidc')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'oidc'}
      reducedMotion={prefersReducedMotion.current}
    >
      <div class="actions">
        <Button
          disabled={isAuthenticating || isLaunchingLogin}
          onclick={() => void onLaunchRedirectLogin('oidc')}
        >
          {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithHomeserver')}
        </Button>
      </div>
    </LoginMethod>
  {/if}

  {#if loginFlows?.sso && (showAllLoginMethods || preferredLoginMethod === 'sso')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'sso'}
      reducedMotion={prefersReducedMotion.current}
    >
      {#if loginFlows.sso_identity_providers.length > 0}
        <div class="actions sso-actions">
          {#each loginFlows.sso_identity_providers as provider (provider.id)}
            <Button
              disabled={isAuthenticating || isLaunchingLogin}
              onclick={() => void onLaunchRedirectLogin('sso', provider.id)}
            >
              {$i18n.t('auth.signInWithProvider', { name: provider.name })}
            </Button>
          {/each}
        </div>
      {:else}
        <div class="actions">
          <Button
            disabled={isAuthenticating || isLaunchingLogin}
            onclick={() => void onLaunchRedirectLogin('sso')}
          >
            {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithSso')}
          </Button>
        </div>
      {/if}
    </LoginMethod>
  {/if}

  {#if loginFlows?.password && (showAllLoginMethods || preferredLoginMethod === 'password')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'password'}
      reducedMotion={prefersReducedMotion.current}
    >
      <PasswordLoginForm
        {username}
        {password}
        invalidField={invalidField === 'homeserver' ? null : invalidField}
        {fieldError}
        {loginError}
        {isAuthenticating}
        {isCheckingHomeserver}
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

  {#if loginFlows && availableLoginMethodCount === 0 && !isCheckingHomeserver}
    <p class="muted">{$i18n.t('errors.unsupportedSignIn')}</p>
  {/if}

  {#if availableLoginMethodCount > 1}
    <AuthMethodToggle
      expanded={showAllLoginMethods}
      showLabel={$i18n.t('auth.moreWaysToSignIn')}
      hideLabel={$i18n.t('auth.hideOtherWaysToSignIn')}
      onToggle={() => {
        showAllLoginMethods = !showAllLoginMethods;
      }}
    />
  {/if}

  {#if (!loginFlows && !isCheckingHomeserver) || (!isPasswordLoginVisible && (fieldError || loginError || core.status === 'error'))}
    <div class="submit-area" out:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}>
      <div class="error-slot" aria-live="polite">
        {#if fieldError || loginError || core.status === 'error'}
          <p class="error">{fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}</p>
        {/if}
      </div>

      {#if !loginFlows}
        <div class="actions">
          <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver}>
            {isCheckingHomeserver ? $i18n.t('auth.checking') : $i18n.t('auth.continue')}
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</form>

{#if onCreateAccount}
  <div class="account-switch">
    <span>{$i18n.t('auth.newToMatrixQuestion')}</span>
    <button class="account-switch-button" type="button" onclick={onCreateAccount}>
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
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    justify-content: center;
    padding-top: 0.875rem;
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
    outline: 0.2rem solid var(--sable-focus-ring);
    outline-offset: 0.15rem;
  }

  .checking {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    margin: 0;
    min-height: 1.25rem;
    visibility: hidden;
  }

  .checking-active {
    visibility: visible;
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

  .error-slot {
    min-height: calc(var(--font-size-small) * var(--line-height-body));
  }

  @keyframes error-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  .field {
    display: grid;
    gap: 0.5rem;
  }

  .login-form {
    min-width: 0;
  }

  .sso-actions {
    gap: 0.75rem;
  }

  .submit-area {
    display: grid;
    gap: 0.5rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .error {
      animation: error-in var(--motion-normal) ease-out;
    }
  }
</style>
