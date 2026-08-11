<script lang="ts">
  import Button from '$lib/ui/primitives/Button.svelte';
  import Combobox from '$lib/ui/primitives/Combobox.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import logo from '$lib/assets/res/svg/logo.svg';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { CommandErr } from '@/generated/CommandErr';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import { CoreError } from '@/transport';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';
  import EyeIcon from 'phosphor-icons-svelte/IconEyeRegular.svelte';
  import EyeSlashIcon from 'phosphor-icons-svelte/IconEyeSlashRegular.svelte';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { fade } from 'svelte/transition';

  const core = useCoreClient();
  const homeservers = ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'];
  const homeserverItems = homeservers.map((value) => ({ value, label: value }));

  type LoginField = 'homeserver' | 'username' | 'password';

  let homeserver = $state(homeservers[0]);
  let username = $state('');
  let password = $state('');
  let loginError = $state<string | null>(null);
  let fieldError = $state<string | null>(null);
  let invalidField = $state<LoginField | null>(null);
  let validatedHomeserver = $state<string | null>(null);
  let loginFlows = $state<LoginFlowsView | null>(null);
  let isCheckingHomeserver = $state(false);
  let validationGeneration = 0;
  let observedHomeserver = homeservers[0];
  let hasInitializedHomeserver = $state(false);
  let isLaunchingLogin = $state(false);
  let isCompletingLogin = false;
  let isAuthenticating = $derived(core.status === 'authenticating');
  let hasLoggedInBefore = $state(false);

  let showPassword = $state(false);
  let showAllLoginMethods = $state(false);

  type LoginMethod = 'oidc' | 'sso' | 'password';
  const loginMethodOrder: LoginMethod[] = ['oidc', 'sso', 'password'];
  let preferredLoginMethod = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return null;
    if (flows.oauth_aware_preferred && flows.sso) return 'sso';
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

  $effect(() => {
    if (homeserver !== observedHomeserver) clearHomeserverValidation();
  });

  $effect(() => {
    if (core.status === 'ready') {
      void goto(resolve('/home'));
    }
  });

  $effect(() => {
    if (core.status !== 'signed-out' || hasInitializedHomeserver) return;

    hasInitializedHomeserver = true;
    void validateHomeserver();
  });

  onMount(() => {
    hasLoggedInBefore = localStorage.getItem('sable-has-logged-in') === 'true';

    let disposed = false;
    let removeDeepLinkListener: (() => void) | undefined;
    let authChannel: BroadcastChannel | undefined;

    const callbackUrl = window.location.href;
    if (!isTauri() && redirectLoginType(callbackUrl)) {
      authChannel = new BroadcastChannel('sable-auth-callback');
      authChannel.postMessage(callbackUrl);
      window.setTimeout(() => {
        window.close();
      }, 0);
    } else if (isTauri()) {
      void listen<string[]>('deep-link://new-url', (event) => {
        const url = event.payload.find((candidate) => redirectLoginType(candidate));
        if (url) void completeRedirectLogin(url);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else removeDeepLinkListener = unlisten;
      });
    } else {
      authChannel = new BroadcastChannel('sable-auth-callback');
      authChannel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'string' && redirectLoginType(event.data)) {
          void completeRedirectLogin(event.data);
        }
      };
    }

    return () => {
      disposed = true;
      removeDeepLinkListener?.();
      authChannel?.close();
    };
  });

  function redirectLoginType(callbackUrl: string): 'oidc' | 'sso' | null {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return null;
    }

    if (url.searchParams.has('loginToken')) return 'sso';
    if (
      url.searchParams.has('state') &&
      (url.searchParams.has('code') || url.searchParams.has('error'))
    ) {
      return 'oidc';
    }
    return null;
  }

  function redirectUri(): string {
    if (isTauri()) return 'moe.sable.next://login';
    return new URL(window.location.pathname, window.location.origin).toString();
  }

  async function completeRedirectLogin(callbackUrl: string): Promise<void> {
    if (isCompletingLogin) return;
    const loginType = redirectLoginType(callbackUrl);
    if (!loginType) return;

    isCompletingLogin = true;
    loginError = null;
    try {
      if (loginType === 'oidc') await core.completeOidcLogin(callbackUrl);
      else await core.completeSsoLogin(callbackUrl);
      localStorage.setItem('sable-has-logged-in', 'true');
    } catch (error) {
      loginError = authenticationError(error);
    } finally {
      isCompletingLogin = false;
    }
  }

  async function launchRedirectLogin(
    loginType: 'oidc' | 'sso',
    identityProviderId?: string
  ): Promise<void> {
    const popup = isTauri()
      ? null
      : window.open('about:blank', 'sable-auth', 'popup,width=520,height=720');
    if (!isTauri() && !popup) {
      loginError = t('auth.allowPopups');
      return;
    }
    if (popup) popup.opener = null;

    isLaunchingLogin = true;
    loginError = null;
    try {
      const flows = await validateHomeserver();
      if (!flows) {
        popup?.close();
        return;
      }

      const authorizationUrl =
        loginType === 'oidc'
          ? await core.startOidcLogin(homeserver.trim(), redirectUri())
          : await core.startSsoLogin(homeserver.trim(), redirectUri(), identityProviderId);

      if (isTauri()) {
        try {
          await invoke('open_auth_url', { url: authorizationUrl });
        } catch (error) {
          throw new CoreError(error as CommandErr);
        }
      } else if (popup) {
        popup.location.replace(authorizationUrl);
      }
    } catch (error) {
      popup?.close();
      loginError = authenticationError(error);
    } finally {
      isLaunchingLogin = false;
    }
  }

  function setFieldError(field: LoginField, message: string) {
    invalidField = field;
    fieldError = message;
    document.getElementById(field)?.focus();
  }

  function clearHomeserverValidation() {
    observedHomeserver = homeserver;
    validationGeneration += 1;
    validatedHomeserver = null;
    loginFlows = null;
    showAllLoginMethods = false;
    isCheckingHomeserver = false;
    loginError = null;
    if (invalidField === 'homeserver') {
      invalidField = null;
      fieldError = null;
    }
  }

  function homeserverError(error: unknown): string {
    if (!(error instanceof CoreError)) {
      return t('errors.homeserverNotFound');
    }

    switch (error.detail.code) {
      case 'unsupported':
        return t('errors.unsupportedSignIn');
      case 'rate_limited':
        return t('errors.checkingTooFast');
      case 'unavailable':
        return t('errors.temporarilyUnavailable');
      default:
        return t('errors.homeserverNotFound');
    }
  }

  function authenticationError(error: unknown): string {
    if (!(error instanceof CoreError)) return t('errors.connectionError');

    switch (error.detail.code) {
      case 'denied':
        return t('errors.invalidCredentials');
      case 'rate_limited':
        return error.detail.retry_after_ms
          ? t('errors.tooManyAttemptsSeconds', {
              seconds: Math.ceil(error.detail.retry_after_ms / 1000),
            })
          : t('errors.tooManyAttempts');
      case 'unavailable':
        return t('errors.temporarilyUnavailable');
      case 'unknown_homeserver':
        return t('errors.homeserverNotFound');
      case 'unsupported':
        return t('errors.passwordUnsupported');
      default:
        return t('errors.coreError');
    }
  }

  async function validateHomeserver(): Promise<LoginFlowsView | null> {
    const candidate = homeserver.trim();
    if (!candidate) {
      setFieldError('homeserver', t('auth.enterHomeserver'));
      return null;
    }

    if (validatedHomeserver === candidate && loginFlows) return loginFlows;

    const generation = ++validationGeneration;
    isCheckingHomeserver = true;
    loginError = null;
    if (invalidField === 'homeserver') {
      invalidField = null;
      fieldError = null;
    }

    try {
      const flows = await core.loginFlows(candidate);
      if (generation !== validationGeneration || homeserver.trim() !== candidate) return null;

      validatedHomeserver = candidate;
      loginFlows = flows;
      return flows;
    } catch (error) {
      if (generation !== validationGeneration || homeserver.trim() !== candidate) return null;
      setFieldError('homeserver', homeserverError(error));
      return null;
    } finally {
      if (generation === validationGeneration) isCheckingHomeserver = false;
    }
  }

  async function login(): Promise<void> {
    loginError = null;
    fieldError = null;
    invalidField = null;

    const flows = await validateHomeserver();
    if (!flows) return;
    if (!flows.password) {
      loginError = t('auth.chooseSignInMethod');
      return;
    }

    if (!username.trim()) {
      setFieldError('username', t('auth.enterUsername'));
      return;
    }

    if (!password) {
      setFieldError('password', t('auth.enterPassword'));
      return;
    }

    try {
      await core.login(homeserver.trim(), username.trim(), password);
      localStorage.setItem('sable-has-logged-in', 'true');
    } catch (error) {
      loginError = authenticationError(error);
    }
  }

  function smoothSlide(node: HTMLElement, { duration }: { duration: number }) {
    const style = getComputedStyle(node);
    const height = parseFloat(style.height);
    const paddingTop = parseFloat(style.paddingTop);
    const paddingBottom = parseFloat(style.paddingBottom);
    const marginTop = parseFloat(style.marginTop);
    const marginBottom = parseFloat(style.marginBottom);
    const borderTopWidth = parseFloat(style.borderTopWidth);
    const borderBottomWidth = parseFloat(style.borderBottomWidth);

    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `
        overflow: hidden;
        opacity: ${String(t)};
        height: ${String(t * height)}px;
        padding-top: ${String(t * paddingTop)}px;
        padding-bottom: ${String(t * paddingBottom)}px;
        margin-top: ${String(t * marginTop)}px;
        margin-bottom: ${String(t * marginBottom)}px;
        border-top-width: ${String(t * borderTopWidth)}px;
        border-bottom-width: ${String(t * borderBottomWidth)}px;
        min-height: 0;
      `,
    };
  }
</script>

<svelte:head>
  <title>Sable</title>
</svelte:head>

<main class="auth-page">
  <section class="auth-content" aria-labelledby="sable-title">
    <header class="auth-heading">
      <img class="logo" src={logo} alt="" />
      <h1 id="sable-title">
        {hasLoggedInBefore ? $i18n.t('auth.welcomeBack') : $i18n.t('auth.welcome')}
      </h1>
    </header>

    <div class="auth-main">
      {#if core.status === 'starting' || core.status === 'idle'}
        <div class="bootstrap" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <p>{$i18n.t('auth.starting')}</p>
        </div>
      {:else if core.status !== 'ready'}
        <form
          class="login-form"
          out:fade={{ duration: prefersReducedMotion.current ? 0 : 200 }}
          aria-busy={isAuthenticating}
          novalidate
          onsubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <div class="field">
            <Label for="homeserver">{$i18n.t('auth.homeserver')}</Label>
            <Combobox
              id="homeserver"
              bind:value={homeserver}
              items={homeserverItems}
              autocapitalize="off"
              autocorrect="off"
              autocomplete="url"
              disabled={isAuthenticating}
              placeholder="matrix.org"
              spellcheck={false}
              required
              ariaInvalid={invalidField === 'homeserver'}
              oninput={() => {
                clearHomeserverValidation();
              }}
              onvaluechange={(selectedHomeserver: string) => {
                homeserver = selectedHomeserver;
                clearHomeserverValidation();
                void validateHomeserver();
              }}
              onblur={() => {
                void validateHomeserver();
              }}
            />
            {#if isCheckingHomeserver}
              <p class="checking" aria-live="polite">
                <span class="spinner" aria-hidden="true"></span>
                {$i18n.t('auth.checkingHomeserver')}
              </p>
            {/if}
          </div>

          {#if loginFlows?.oidc && (showAllLoginMethods || preferredLoginMethod === 'oidc')}
            <div
              class="login-method"
              class:method-divider={showAllLoginMethods && firstAvailableLoginMethod !== 'oidc'}
              transition:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}
            >
              <div class="actions">
                <Button
                  disabled={isAuthenticating || isLaunchingLogin}
                  onclick={() => void launchRedirectLogin('oidc')}
                >
                  {isLaunchingLogin
                    ? $i18n.t('auth.opening')
                    : $i18n.t('auth.signInWithHomeserver')}
                </Button>
              </div>
            </div>
          {/if}

          {#if loginFlows?.sso && (showAllLoginMethods || preferredLoginMethod === 'sso')}
            <div
              class="login-method"
              class:method-divider={showAllLoginMethods && firstAvailableLoginMethod !== 'sso'}
              transition:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}
            >
              {#if loginFlows.sso_identity_providers.length > 0}
                <div class="actions sso-actions">
                  {#each loginFlows.sso_identity_providers as provider (provider.id)}
                    <Button
                      disabled={isAuthenticating || isLaunchingLogin}
                      onclick={() => void launchRedirectLogin('sso', provider.id)}
                    >
                      {$i18n.t('auth.signInWithProvider', { name: provider.name })}
                    </Button>
                  {/each}
                </div>
              {:else}
                <div class="actions">
                  <Button
                    disabled={isAuthenticating || isLaunchingLogin}
                    onclick={() => void launchRedirectLogin('sso')}
                  >
                    {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithSso')}
                  </Button>
                </div>
              {/if}
            </div>
          {/if}

          {#if loginFlows?.password && (showAllLoginMethods || preferredLoginMethod === 'password')}
            <div
              class="login-method"
              class:method-divider={showAllLoginMethods && firstAvailableLoginMethod !== 'password'}
              transition:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}
            >
              <div class="field">
                <Label for="username">{$i18n.t('auth.username')}</Label>
                <TextInput
                  id="username"
                  bind:value={username}
                  autocomplete="username"
                  required
                  disabled={isAuthenticating}
                  aria-invalid={invalidField === 'username'}
                  oninput={() => {
                    if (invalidField === 'username') {
                      invalidField = null;
                      fieldError = null;
                    }
                  }}
                />
              </div>

              <div class="field">
                <Label for="password">{$i18n.t('auth.password')}</Label>
                <div class="password-input">
                  <TextInput
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    bind:value={password}
                    autocomplete="current-password"
                    required
                    disabled={isAuthenticating}
                    aria-invalid={invalidField === 'password'}
                    oninput={() => {
                      if (invalidField === 'password') {
                        invalidField = null;
                        fieldError = null;
                      }
                    }}
                  />

                  <button
                    class="password-toggle"
                    type="button"
                    disabled={isAuthenticating}
                    aria-label={showPassword
                      ? $i18n.t('auth.hidePassword')
                      : $i18n.t('auth.showPassword')}
                    aria-pressed={showPassword}
                    onclick={() => {
                      showPassword = !showPassword;
                    }}
                    ><span class="password-toggle-icon" aria-hidden="true">
                      {#key showPassword}
                        {#if showPassword}
                          <EyeSlashIcon />
                        {:else}
                          <EyeIcon />
                        {/if}
                      {/key}
                    </span>
                  </button>
                </div>
              </div>

              <div class="submit-area">
                <div class="error-slot" aria-live="polite">
                  {#if fieldError || loginError || core.status === 'error'}
                    <p class="error">
                      {fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}
                    </p>
                  {/if}
                </div>

                <div class="actions">
                  <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver}>
                    {#if isAuthenticating}
                      <span class="spinner" aria-hidden="true"></span>
                    {/if}

                    {isAuthenticating ? $i18n.t('auth.signingIn') : $i18n.t('auth.signIn')}
                  </Button>
                </div>
              </div>
            </div>
          {/if}

          {#if availableLoginMethodCount > 1}
            <button
              class="method-toggle"
              type="button"
              aria-expanded={showAllLoginMethods}
              onclick={() => {
                showAllLoginMethods = !showAllLoginMethods;
              }}
            >
              <span
                >{showAllLoginMethods
                  ? $i18n.t('auth.hideOtherWaysToSignIn')
                  : $i18n.t('auth.moreWaysToSignIn')}</span
              >
              <span
                class:expanded={showAllLoginMethods}
                class="method-toggle-icon"
                aria-hidden="true"
              >
                <CaretDownIcon />
              </span>
            </button>
          {/if}

          {#if !loginFlows || (!isPasswordLoginVisible && (fieldError || loginError || core.status === 'error'))}
            <div
              class="submit-area"
              transition:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}
            >
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
      {/if}
    </div>
  </section>

  <footer class="auth-footer">
    <a href="https://github.com/SableClient/sable-next" rel="noreferrer" target="_blank">
      {$i18n.t('footer.sourceCode')}
    </a>
    <span aria-hidden="true">·</span>
    <span
      >{$i18n.t('footer.poweredBy')}
      <a href="https://matrix.org" rel="noreferrer" target="_blank">Matrix</a></span
    >
  </footer>
</main>

<style>
  .actions {
    display: grid;
  }

  .auth-page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    padding: 2rem 1.5rem;
  }

  .auth-content {
    display: grid;
    flex: 1 0 auto;
    grid-template-rows: calc((100dvh - 4rem) / 3) auto;
    margin: 0 auto;
    max-width: 24rem;
    width: 100%;
  }

  .auth-main {
    align-self: start;
    padding-bottom: 3rem;
  }

  .auth-footer {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    justify-content: center;
    margin: 1rem auto 0;
  }

  .auth-footer a {
    color: inherit;
  }

  .auth-footer a:hover {
    color: var(--sable-bg-on-container);
  }

  .method-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    justify-content: center;
    padding: 0.25rem;
  }

  .method-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .method-toggle-icon {
    align-items: center;
    display: flex;
  }

  .method-toggle-icon :global(svg) {
    height: 1rem;
    width: 1rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .method-toggle-icon {
      transition: transform var(--motion-normal) ease;
    }

    .method-toggle-icon.expanded {
      transform: rotate(180deg);
    }
  }

  .auth-heading {
    align-self: end;
    margin-bottom: 2rem;
    text-align: center;
  }

  .auth-heading h1 {
    font-size: var(--font-size-xlarge);
    margin: 1rem 0 0;
  }

  .bootstrap {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  .bootstrap p {
    margin: 0;
  }

  .checking {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    margin: 0;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .error-slot {
    min-height: 0.75rem;
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

  .logo {
    filter: drop-shadow(0 0.375rem 0.625rem rgb(0 0 0 / 20%));
    height: 4rem;
    width: 4rem;
  }

  .login-form {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: calc(var(--radius) * 1.5);
    display: grid;
    gap: 1.5rem;
    padding: 1.75rem;
  }

  .login-method {
    display: grid;
    gap: 1.5rem;
  }

  .method-divider {
    border-top: 1px solid var(--sable-surface-container-line);
    padding-top: 1.5rem;
  }

  .sso-actions {
    gap: 0.75rem;
  }

  .password-input {
    --input-padding-right: 2.75rem;

    display: grid;
    position: relative;
  }

  .password-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    height: 100%;
    justify-content: center;
    padding: 0;
    position: absolute;
    right: 0;
    top: 0;
    width: 2.75rem;
  }

  .password-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .password-toggle:active {
    transform: scale(0.92);
  }

  .password-toggle:focus-visible {
    border-radius: var(--radius);
    outline: 2px solid var(--sable-focus-ring);
    outline-offset: -4px;
  }

  .password-toggle-icon {
    align-items: center;
    display: flex;
    justify-content: center;
  }

  .password-toggle-icon :global(svg) {
    height: 18px;
    width: 18px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .error {
      animation: error-in var(--motion-normal) ease-out;
    }

    .password-toggle {
      transition:
        color 120ms ease,
        transform 100ms ease;
    }

    .password-toggle-icon :global(svg) {
      animation: password-icon-in 180ms ease-out;
    }

    .spinner {
      animation: spin 0.8s linear infinite;
    }
  }

  @keyframes password-icon-in {
    from {
      opacity: 0;
      transform: scale(0.8) rotate(-4deg);
    }

    to {
      opacity: 1;
      transform: scale(1) rotate(0);
    }
  }

  .spinner {
    border: 2px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    border-right-color: var(--sable-primary-main);
    height: 1.25rem;
    width: 1.25rem;
  }

  .checking .spinner {
    height: 1rem;
    width: 1rem;
  }

  .submit-area {
    display: grid;
    gap: 0.5rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
