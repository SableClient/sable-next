<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import {
    callbackChannelName,
    createRedirectUri,
    redirectLoginType,
    scrubbedCallbackPath,
    type RedirectLoginType,
  } from '$lib/auth/redirect';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import type { CommandErr } from '@/generated/CommandErr';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import { CoreError } from '@/transport';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import AuthFooter from '$lib/features/auth/AuthFooter.svelte';
  import AuthHeader from '$lib/features/auth/AuthHeader.svelte';
  import LoginForm from '$lib/features/auth/LoginForm.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  const core = useCoreClient();
  const homeservers = ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'];

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
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const handledCallbackUrls = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const authChannels = new Set<BroadcastChannel>();
  let hasLoggedInBefore = $state(false);

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
    let callbackChannel: BroadcastChannel | undefined;
    const isDisposed = () => disposed;

    const callbackUrl = window.location.href;
    if (!isTauri() && redirectLoginType(callbackUrl)) {
      callbackChannel = new BroadcastChannel(callbackChannelName(callbackUrl, window.name));
      callbackChannel.postMessage(callbackUrl);
      history.replaceState(history.state, '', scrubbedCallbackPath(callbackUrl));
      window.setTimeout(() => {
        window.close();
      }, 0);
    } else if (isTauri()) {
      void (async () => {
        try {
          const unlisten = await listen<string[]>('deep-link://new-url', (event) => {
            const url = event.payload.find((candidate) => redirectLoginType(candidate));
            if (url) void completeRedirectLogin(url);
          });
          if (isDisposed()) {
            unlisten();
            return;
          }
          removeDeepLinkListener = unlisten;

          const urls = await invoke<string[] | null>('plugin:deep-link|get_current');
          const url = urls?.find((candidate) => redirectLoginType(candidate));
          if (!isDisposed() && url) void completeRedirectLogin(url);
        } catch {
          // The app can run without the deep-link plugin in browser development.
        }
      })();
    }

    return () => {
      disposed = true;
      removeDeepLinkListener?.();
      callbackChannel?.close();
      for (const authChannel of authChannels) authChannel.close();
      authChannels.clear();
    };
  });

  function redirectUri(loginType: RedirectLoginType): string {
    const baseUrl = isTauri()
      ? 'moe.sable.next://login'
      : new URL(window.location.pathname, window.location.origin).toString();
    return createRedirectUri(loginType, baseUrl, crypto.randomUUID());
  }

  async function completeRedirectLogin(callbackUrl: string): Promise<void> {
    if (isCompletingLogin) return;
    const loginType = redirectLoginType(callbackUrl);
    if (!loginType || handledCallbackUrls.has(callbackUrl)) return;

    handledCallbackUrls.add(callbackUrl);
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
    const popupName = `sable-auth-${crypto.randomUUID()}`;
    const popup = isTauri()
      ? null
      : window.open('about:blank', popupName, 'popup,width=520,height=720');
    if (!isTauri() && !popup) {
      loginError = t('auth.allowPopups');
      return;
    }
    let authChannel: BroadcastChannel | undefined;

    isLaunchingLogin = true;
    loginError = null;
    try {
      const flows = await validateHomeserver();
      if (!flows) {
        popup?.close();
        authChannel?.close();
        if (authChannel) authChannels.delete(authChannel);
        return;
      }

      const callbackUri = redirectUri(loginType);
      const authorizationUrl =
        loginType === 'oidc'
          ? await core.startOidcLogin(homeserver.trim(), callbackUri)
          : await core.startSsoLogin(homeserver.trim(), callbackUri, identityProviderId);

      if (isTauri()) {
        try {
          await invoke('open_auth_url', { url: authorizationUrl });
        } catch (error) {
          throw new CoreError(error as CommandErr);
        }
      } else if (popup) {
        const channel = new BroadcastChannel(
          callbackChannelName(loginType === 'oidc' ? authorizationUrl : callbackUri, popup.name)
        );
        authChannel = channel;
        authChannels.add(channel);
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data === 'string' && redirectLoginType(event.data)) {
            void completeRedirectLogin(event.data);
            channel.close();
            authChannels.delete(channel);
          }
        };
        popup.location.replace(authorizationUrl);
      }
    } catch (error) {
      popup?.close();
      authChannel?.close();
      if (authChannel) authChannels.delete(authChannel);
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

  function clearFieldError(field: Exclude<LoginField, 'homeserver'>) {
    if (invalidField === field) {
      invalidField = null;
      fieldError = null;
    }
  }

  function clearHomeserverValidation() {
    observedHomeserver = homeserver;
    validationGeneration += 1;
    validatedHomeserver = null;
    loginFlows = null;
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
</script>

<svelte:head>
  <title>Sable</title>
</svelte:head>

<main class="auth-page">
  <section class="auth-content" aria-labelledby="sable-title">
    <AuthHeader {hasLoggedInBefore} />

    <div class="auth-main">
      {#if core.status === 'starting' || core.status === 'idle'}
        <div class="bootstrap" aria-live="polite">
          <Spinner />
          <p>{$i18n.t('auth.starting')}</p>
        </div>
      {:else if core.status !== 'ready'}
        <LoginForm
          bind:homeserver
          bind:username
          bind:password
          {loginFlows}
          {invalidField}
          {fieldError}
          {loginError}
          {isCheckingHomeserver}
          {isLaunchingLogin}
          onClearHomeserverValidation={clearHomeserverValidation}
          onValidateHomeserver={validateHomeserver}
          onClearFieldError={clearFieldError}
          onLaunchRedirectLogin={launchRedirectLogin}
          onLogin={login}
        />
      {/if}
    </div>
  </section>

  <AuthFooter />
</main>

<style>
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

  .bootstrap {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  .bootstrap p {
    margin: 0;
  }
</style>
