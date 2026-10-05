<script lang="ts">
  import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
  import { fade } from 'svelte/transition';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import type { LoginFlowsView } from '#src/generated/protocol';
  import Button from '#lib/ui/primitives/Button.svelte';
  import AuthMethodToggle from '../shared/AuthMethodToggle.svelte';
  import LoginMethod from './LoginMethod.svelte';
  import PasswordLoginForm from './PasswordLoginForm.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';
  import HomeserverPicker from '../shared/HomeserverPicker.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import LoginProviderButton from './LoginProviderButton.svelte';
  import { resetPasswordHref } from '../reset-password/reset-password-url';
  import { homeservers } from '../shared/homeservers.svelte.js';
  import { passwordFields } from '../shared/password-fields.svelte.js';
  import { sameServer, userIdServer } from './login-identifier';

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
    onQrLogin?: () => void;
    onCreateAccount?: () => void;
    onCancel?: () => void;
    followUserServer?: boolean;
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
    onQrLogin,
    onLogin,
    onCreateAccount,
    onCancel,
    followUserServer = true,
  }: Props = $props();

  const core = useCoreClient();
  let isAuthenticating = $derived(core.status === 'authenticating');
  let showAllLoginMethods = $state(false);
  let displayedHomeserver = $state(homeserver);
  let isLoginControlsDisabled = $derived(
    isCheckingHomeserver || homeserver !== displayedHomeserver
  );

  const loginMethodOrder: Array<'oidc' | 'sso' | 'password'> = ['oidc', 'sso', 'password'];
  let offeredFlows = $derived(
    loginFlows && passwordFields.hidden ? { ...loginFlows, password: false } : loginFlows
  );
  let preferredLoginMethod = $derived.by(() => {
    const flows = offeredFlows;
    if (!flows) return null;
    if (flows.oauth_aware_preferred && flows.oidc) return 'oidc';
    return loginMethodOrder.find((method) => flows[method]) ?? null;
  });
  let availableLoginMethodCount = $derived.by(() => {
    const flows = offeredFlows;
    if (!flows) return 0;
    return loginMethodOrder.filter((method) => flows[method]).length;
  });
  let isPasswordLoginVisible = $derived(
    offeredFlows?.password === true && (showAllLoginMethods || preferredLoginMethod === 'password')
  );
  let forgotPasswordHref = $derived(
    offeredFlows?.password && !offeredFlows.oidc ? resetPasswordHref(displayedHomeserver) : null
  );
  let hasLoginAction = $derived(loginFlows === null || preferredLoginMethod !== null);
  let userServerError = $state<string | null>(null);
  let declinedServer: string | null = null;
  let usernameServer = $derived(followUserServer ? userIdServer(username) : null);
  let statusError = $derived(
    userServerError ??
      (!isPasswordLoginVisible && (fieldError || loginError || core.status === 'error')
        ? (fieldError ?? loginError ?? $i18n.t('auth.unableToStart'))
        : null)
  );
  let statusMessage = $derived(
    statusError ??
      (loginFlows && availableLoginMethodCount === 0
        ? $i18n.t('errors.unsupportedSignIn')
        : usernameServer && sameServer(displayedHomeserver, usernameServer)
          ? $i18n.t('auth.signingInOn', { server: usernameServer })
          : null)
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

  async function followUsernameServer(): Promise<boolean | null> {
    const server = usernameServer;
    if (!server || server === declinedServer || sameServer(homeserver, server)) return null;
    if (!homeservers.allowCustom && !homeservers.list.includes(server)) {
      declinedServer = server;
      userServerError = $i18n.t('auth.userServerNotFound', { server });
      return false;
    }
    const previous = homeserver;
    homeserver = server;
    userServerError = null;
    onClearHomeserverValidation();
    const pending = validateHomeserver();
    const validation = latestValidation;
    const flows = await pending;
    if (flows) return true;
    if (validation !== latestValidation || homeserver !== server) return false;
    homeserver = previous;
    onClearHomeserverValidation();
    declinedServer = server;
    userServerError = $i18n.t('auth.userServerNotFound', { server });
    return false;
  }

  async function submit(): Promise<void> {
    if ((await followUsernameServer()) === false) return;
    await onLogin();
  }
</script>

<form
  class="login-form auth-card-surface"
  out:fade={{ duration: motionMs(MOTION_MS.quick) }}
  aria-busy={isAuthenticating}
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <FormField dense fieldId="homeserver" label={$i18n.t('auth.accountProvider')}>
    <HomeserverPicker
      id="homeserver"
      bind:value={homeserver}
      disabled={isAuthenticating}
      required
      ariaInvalid={invalidField === 'homeserver'}
      oninput={() => {
        userServerError = null;
        onClearHomeserverValidation();
      }}
      onvaluechange={(selectedHomeserver: string) => {
        homeserver = selectedHomeserver;
        userServerError = null;
        onClearHomeserverValidation();
        void validateHomeserver();
      }}
      onblur={() => void validateHomeserver()}
      onsettle={() => void validateHomeserver()}
    />
  </FormField>

  <AuthStatusSlot
    loading={isCheckingHomeserver}
    loadingMessage={$i18n.t('auth.checkingProvider')}
    message={statusMessage}
    tone={statusError ? 'error' : 'muted'}
  />

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
        <LoginMethod>
          <div class="actions sso-actions">
            <LoginProviderButton
              label={$i18n.t('auth.signInWithProvider', {
                name: displayedHomeserver || 'matrix.org',
              })}
              launching={isLaunchingLogin}
              disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
              onclick={() => void onLaunchRedirectLogin('oidc')}
            />
            {#if onQrLogin}
              <Button
                variant="ghost"
                disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
                onclick={onQrLogin}
              >
                <QrCodeIcon size={18} aria-hidden="true" />{$i18n.t('qrLogin.signInWithQr')}
              </Button>
            {/if}
          </div>
        </LoginMethod>
      {/if}

      {#if loginFlows?.sso && (showAllLoginMethods || preferredLoginMethod === 'sso')}
        <LoginMethod>
          {#if loginFlows.sso_identity_providers.length > 0}
            <div class="actions sso-actions">
              {#each loginFlows.sso_identity_providers as provider (provider.id)}
                <LoginProviderButton
                  label={$i18n.t('auth.signInWithProvider', { name: provider.name })}
                  launching={isLaunchingLogin}
                  disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
                  onclick={() => void onLaunchRedirectLogin('sso', provider.id)}
                />
              {/each}
            </div>
          {:else}
            <div class="actions">
              <LoginProviderButton
                label={$i18n.t('auth.signInWithSso')}
                launching={isLaunchingLogin}
                disabled={isAuthenticating || isLoginControlsDisabled || isLaunchingLogin}
                onclick={() => void onLaunchRedirectLogin('sso')}
              />
            </div>
          {/if}
        </LoginMethod>
      {/if}

      {#if isPasswordLoginVisible}
        <LoginMethod>
          <PasswordLoginForm
            invalidField={invalidField === 'homeserver' ? null : invalidField}
            {fieldError}
            {loginError}
            {isAuthenticating}
            isCheckingHomeserver={isLoginControlsDisabled}
            resetPasswordHref={forgotPasswordHref}
            bind:username
            bind:password
            onClearFieldError={(field: Exclude<LoginField, 'homeserver'>) => {
              if (field === 'username') {
                userServerError = null;
                declinedServer = null;
              }
              onClearFieldError(field);
            }}
            onUsernameBlur={() => void followUsernameServer()}
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

<div class="account-switch">
  {#if onCancel}
    <Button variant="ghost" type="button" onclick={onCancel}>
      {$i18n.t('auth.cancelAddingAccount')}
    </Button>
  {:else if onCreateAccount}
    <Button
      variant="ghost"
      type="button"
      disabled={isLoginControlsDisabled}
      onclick={onCreateAccount}
    >
      {$i18n.t('auth.createAccount')}
    </Button>
  {/if}
</div>

<style>
  .actions {
    display: grid;
  }

  .account-switch {
    align-items: center;
    color: var(--sec-main);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    justify-content: center;
    padding-top: var(--space-200);
    text-align: center;
  }

  .login-form {
    min-width: 0;
  }

  .login-methods {
    display: grid;
    gap: var(--space-400);
    min-width: 0;
  }

  .method-slot {
    display: grid;
    gap: var(--space-400);
    min-width: 0;
  }

  .method-slot:not(.action-slot) {
    display: none;
  }

  .action-slot {
    min-height: var(--control-height-400);
  }

  .sso-actions {
    gap: var(--space-300);
  }
</style>
