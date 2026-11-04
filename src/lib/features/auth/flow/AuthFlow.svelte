<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import QrLinkDialog from '#lib/features/qr-login/QrLinkDialog.svelte';
  import '#lib/features/auth/shared/auth-card.css';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { i18n } from '#lib/i18n.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import { useCoreClient } from '#lib/core/context.js';
  import AuthPage from '#lib/features/auth/shared/AuthPage.svelte';
  import AuthRedirectBridge from './AuthRedirectBridge.svelte';
  import AuthRail from './AuthRail.svelte';
  import AuthStageCard from './AuthStageCard.svelte';
  import { furthestReachableStage, stageIndexForPath } from './stageRegistry';
  import { AuthFlowController, LOGGED_IN_MARKER, readReturningUser } from './auth-flow.svelte';
  import { LoginController, type LoginField } from '../login/login-controller.svelte';
  import LoginForm from '../login/LoginForm.svelte';
  import DeviceVerificationDialog from '#lib/features/settings/DeviceVerificationDialog.svelte';
  import {
    RegistrationController,
    type RegistrationField,
  } from '../registration/registration-controller.svelte';
  import RegistrationCard from '../registration/RegistrationCard.svelte';
  import AccountSummaryCard from '../profile/AccountSummaryCard.svelte';
  import { profileOnboardingMarker } from '../profile/profile-controller.svelte';
  import SetupFlow from '../setup/SetupFlow.svelte';
  import { RedirectController } from './redirect-controller.svelte';
  import { homeserverFromAuthUrl, registrationTokenFromAuthUrl } from './auth-url';
  import { homeservers } from '../shared/homeservers.svelte.js';
  import { takeAfterLogin } from '#lib/auth/after-login.js';
  import { readText, writeJson, writeText } from '#lib/platform/local-json.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { registrationEnabled, ssoRedirect } from '#lib/deployment/policy.js';
  import { loginConfiguration, clearLoginConfiguration } from '#lib/deployment/deployment.js';
  import { passwordFields } from '../shared/password-fields.svelte.js';
  import { shouldAutoRedirect } from './auto-redirect';

  const core = useCoreClient();
  const isAddingAccount = page.url.searchParams.has('addAccount');
  const canRegister = $derived(registrationEnabled(loginConfiguration()));
  const stageRegistry = $derived([
    {
      route: resolve('login'),
      completed: true,
    },
    ...(canRegister
      ? [
          {
            route: resolve('register'),
            completed: false,
          },
        ]
      : []),
  ]);

  function reauthAccountId(): string | undefined {
    const explicit = page.url.searchParams.get('reauth');
    if (explicit) return explicit;
    if (page.url.searchParams.has('addAccount')) return undefined;
    const account = core.accounts.length === 1 ? core.accounts[0] : undefined;
    return account?.needs_reauth ? account.account_id : undefined;
  }

  const flow = new AuthFlowController(
    core,
    homeserverFromAuthUrl(page.url, page.route.id) ?? homeservers.default,
    registrationTokenFromAuthUrl(page.url)
  );
  let hasCompletedInitialHomeserverCheck = $state(false);
  let hasLoggedInBefore = $state(false);
  let initialized = false;
  let pendingStage = $state<number | null>(null);
  let enteringStage = $state<number | null>(null);
  let retiringAfter = $state<number | null>(null);
  let furthestReached = $state(
    untrack(() =>
      Math.min(stageIndexForPath(page.url.pathname, stageRegistry), core.status === 'ready' ? 1 : 0)
    )
  );
  let lastUrlPrefill = '';
  let loginPending = $state(false);

  function markLoggedIn(): void {
    writeText(LOGGED_IN_MARKER, 'true');
    hasLoggedInBefore = true;
  }

  function markOnboardingPending(matrixId: string): void {
    writeJson(profileOnboardingMarker(matrixId), { homeserver: flow.homeserver });
  }

  function openSetup(): Promise<void> {
    return goto(resolve('setup'));
  }

  let qrLoginOpen = $state(false);

  const redirect = new RedirectController({
    core,
    getReauthAccountId: reauthAccountId,
    getHomeserver: () => flow.homeserver,
    getValidationError: () => flow.error,
    validateHomeserver: () => flow.validateHomeserver(0),
    onMarkLoggedIn: markLoggedIn,
    onMarkOnboardingPending: markOnboardingPending,
    onNavigateLoginVerification: openSetup,
    onNavigateRegistrationRecovery: openSetup,
  });

  const registration = new RegistrationController(
    {
      core,
      getHomeserver: () => flow.homeserver,
      getRegistrationFlows: () => flow.registrationFlows,
      getHomeserverError: () => flow.error,
      validateHomeserver: () => flow.validateHomeserver(1),
      onEditHomeserver: () => {
        flow.isEditingHomeserver = true;
      },
      onMarkOnboardingPending: markOnboardingPending,
      onRegistrationComplete: openSetup,
      onOpenFallback: (fallback, onComplete) => {
        redirect.openFallback(fallback, onComplete);
      },
    },
    registrationTokenFromAuthUrl(page.url)
  );

  const login = new LoginController({
    core,
    getReauthAccountId: reauthAccountId,
    getHomeserver: () => flow.homeserver,
    getValidationError: () => flow.error,
    validateHomeserver: () => flow.validateHomeserver(0),
    onInvalidateStage: () => {
      invalidateAfter(0);
    },
    onMarkLoggedIn: markLoggedIn,
    onMarkHomeserverChanged: () => {
      flow.clearLoginHomeserverValidation();
    },
  });

  $effect(() => {
    const accountId = reauthAccountId();
    const account = core.accounts.find((account) => account.account_id === accountId);
    if (account && !login.username) login.username = account.user_id;
  });

  let isSetupRoute = $derived(page.url.pathname.startsWith(resolve('setup')));
  let requestedStage = $derived(stageIndexForPath(page.url.pathname, stageRegistry));
  let signedIn = $derived(core.status === 'ready' && !isAddingAccount);
  let stages = $derived(
    stageRegistry.map((stage, index) => ({
      ...stage,
      completed: index === 0 || (index === 1 && signedIn),
    }))
  );

  let activeIndex = $derived(furthestReachableStage(requestedStage, stages));
  let hasSecondaryStage = $derived(
    canRegister && (furthestReached >= 1 || core.status === 'signed-out' || isAddingAccount)
  );
  let visibleFurthestStage = $derived(
    hasSecondaryStage ? Math.max(furthestReached, 1) : furthestReached
  );
  let displayedStage = $derived(pendingStage ?? activeIndex);
  let userId = $derived(core.session?.user_id ?? '');
  let pendingOnboardingTransition = $derived(
    registration.pendingOnboardingTransition || redirect.pendingOnboardingTransition
  );
  let registrationError = $derived(registration.error ?? redirect.registrationError ?? flow.error);
  let loginError = $derived(
    login.error ?? redirect.loginError ?? (displayedStage === 0 ? flow.error : null)
  );
  let isRegistering = $derived(
    registration.isRegistering || (redirect.pendingIntent === 'register' && redirect.isLaunching)
  );
  let isLaunchingLogin = $derived(redirect.pendingIntent === 'login' && redirect.isLaunching);
  let canForward = $derived(
    (displayedStage === 0 && hasSecondaryStage && flow.loginProviderReady) ||
      (displayedStage === 1 && signedIn)
  );

  $effect(() => {
    if (!canRegister && page.url.pathname.startsWith(resolve('register'))) {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- stageRoute() extends a resolved stage route
      void goto(stageRoute(0), { replaceState: true });
    }
  });

  let autoRedirectTried = false;
  $effect(() => {
    if (core.status !== 'signed-out' && !isAddingAccount) return;
    if (!flow.loginProviderReady || redirect.isCallbackWindow) return;
    if (redirect.isLaunching || redirect.isCompleting) return;
    const flows =
      flow.loginFlows && passwordFields.hidden
        ? { ...flow.loginFlows, password: false }
        : flow.loginFlows;
    const target = shouldAutoRedirect(
      ssoRedirect(loginConfiguration()),
      flows,
      displayedStage === 0 ? 'login' : 'registration',
      autoRedirectTried
    );
    if (!target) return;
    autoRedirectTried = true;
    void untrack(() =>
      redirect.launch(target.type, target.type === 'sso' ? target.id : undefined, 'login')
    );
  });

  $effect(() => {
    if (flow.shouldValidateRegistration(displayedStage, hasCompletedInitialHomeserverCheck)) {
      void flow.validateRegistrationHomeserver();
    }
  });

  $effect(() => {
    const urlKey = `${page.url.pathname}${page.url.search}`;
    if (urlKey === lastUrlPrefill) return;
    lastUrlPrefill = urlKey;
    const urlHomeserver = homeserverFromAuthUrl(page.url, page.route.id);
    const urlToken = registrationTokenFromAuthUrl(page.url);
    if (urlHomeserver) {
      const homeserverChanged = urlHomeserver !== flow.homeserver.trim();
      flow.homeserver = urlHomeserver;
      registration.registrationToken = urlToken;
      if (homeserverChanged) {
        redirect.cleanup();
        flow.resetValidation();
        login.resetForHomeserverChange();
        registration.error = null;
        redirect.loginError = null;
        redirect.registrationError = null;
      }
    } else if (urlToken) {
      registration.registrationToken = urlToken;
    }
  });

  $effect(() => {
    const next = activeIndex;
    if (next > untrack(() => furthestReached)) furthestReached = next;
  });

  $effect(() => {
    if ((!isAddingAccount && core.status !== 'signed-out') || initialized) return;
    initialized = true;
    const reauth = core.accounts.find((account) => account.account_id === reauthAccountId());
    if (reauth) flow.homeserver = reauth.homeserver;
    void untrack(() =>
      flow.validateInitialHomeserver(displayedStage).finally(() => {
        hasCompletedInitialHomeserverCheck = true;
      })
    );
  });

  $effect(() => {
    if (core.status !== 'ready' || !userId || pendingOnboardingTransition || isAddingAccount)
      return;
    if (isSetupRoute || loginPending || qrLoginOpen) return;
    if (redirect.pendingIntent === 'login' && redirect.isCompleting) return;
    if (readText(profileOnboardingMarker(userId))) void openSetup();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- takeAfterLogin() returns a resolved path
    else void goto(takeAfterLogin(resolve('/(app)/rooms')));
  });

  async function signInWithPassword(): Promise<void> {
    loginPending = true;
    await login.login();
    if (!login.error && !login.fieldError && core.status === 'ready') await openSetup();
    loginPending = false;
  }

  function showRegistrationStage(): void {
    activateStage(1);
  }

  onMount(() => {
    hasLoggedInBefore = readReturningUser();
    return () => {
      clearLoginConfiguration();
      redirect.cleanup();
      if (!redirect.isCallbackWindow)
        void core.rpc.auth.cancelRegistration().catch((error: unknown) => {
          console.debug('[sable auth] cancelling registration failed', error);
        });
    };
  });

  function back(): void {
    if (displayedStage <= 0) return;
    activateStage(Math.max(0, displayedStage - 1));
  }

  function forward(): void {
    if (!canForward) return;
    if (displayedStage === 0) activateStage(1);
    else void openSetup();
  }

  function activateStage(index: number): void {
    if (index === displayedStage || pendingStage !== null || retiringAfter !== null) return;
    if (index < 0 || index >= stageRegistry.length) return;
    if (index > furthestReached) {
      furthestReached = index;
      enteringStage = index;
      if (shouldReduceMotion()) enteringStage = null;
    }
    pendingStage = index;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- stageRoute() extends a resolved stage route
    void goto(stageRoute(index), { reset: false }).finally(() => {
      pendingStage = null;
    });
  }

  function stageRoute(index: number): string {
    const base = stageRegistry[index].route;
    const server = flow.homeserver.trim();
    const route =
      server &&
      server !== homeservers.default &&
      !server.includes('/') &&
      !server.includes('?') &&
      !server.includes('#')
        ? `${base}/${encodeURIComponent(server)}`
        : base;
    const query = new SvelteURLSearchParams();
    for (const key of ['addAccount', 'reauth']) {
      const value = page.url.searchParams.get(key);
      if (value !== null) query.set(key, value);
    }
    const token = registration.registrationToken?.trim();
    if (index === 1 && token) query.set('registration_token', token);
    const search = query.toString();
    return search ? `${route}?${search}` : route;
  }

  function invalidateAfter(index: number): void {
    if (furthestReached <= index || retiringAfter !== null) return;
    retiringAfter = index;
    if (shouldReduceMotion()) {
      furthestReached = index;
      retiringAfter = null;
    }
  }

  function completeStageMotion(index: number): void {
    if (enteringStage === index) enteringStage = null;
    if (retiringAfter === index) {
      furthestReached = index;
      retiringAfter = null;
    }
  }
</script>

<PageTitle
  title={i18n.t(
    isSetupRoute ? 'setup.title' : displayedStage === 0 ? 'auth.signInTitle' : 'auth.createAccount'
  )}
/>

{#snippet loginStageContent(showCreateAccount: boolean)}
  <LoginForm
    bind:homeserver={flow.homeserver}
    bind:username={login.username}
    bind:password={login.password}
    loginFlows={flow.loginFlows}
    invalidField={login.invalidField}
    fieldError={login.fieldError}
    {loginError}
    isCheckingHomeserver={flow.isCheckingHomeserver}
    {isLaunchingLogin}
    onClearHomeserverValidation={() => {
      redirect.cleanup();
      invalidateAfter(0);
      login.clearHomeserverValidation();
    }}
    onValidateHomeserver={() => flow.validateHomeserver(0)}
    onClearFieldError={(field: Exclude<LoginField, 'homeserver'>) => {
      invalidateAfter(0);
      login.clearFieldError(field);
    }}
    onLaunchRedirectLogin={async (type: 'oidc' | 'sso', id?: string) => {
      await redirect.launch(type, id, 'login');
    }}
    onLogin={signInWithPassword}
    onQrLogin={reauthAccountId()
      ? undefined
      : () => {
          qrLoginOpen = true;
        }}
    onCreateAccount={showCreateAccount ? showRegistrationStage : undefined}
    onCancel={isAddingAccount ? () => goto(resolve('home')) : undefined}
    followUserServer={!reauthAccountId()}
  />
  {#if redirect.pendingIntent === 'login'}
    {@render browserFallback()}
  {/if}
{/snippet}

{#snippet browserFallback()}
  {#if redirect.systemBrowserUrl}
    <p class="browser-fallback">{i18n.t('auth.continueInBrowserHint')}</p>
    <Button
      block
      loading={redirect.isOpeningSystemBrowser}
      onclick={() => void redirect.openInBrowser()}
    >
      {i18n.t('auth.openInBrowser')}
    </Button>
  {/if}
{/snippet}

<AuthRedirectBridge
  onCallback={(url: string) => {
    void redirect.complete(url);
  }}
  onRegistrationComplete={() => {
    void core.start().then(() => {
      if (core.status === 'ready') void openSetup();
    });
  }}
  onCallbackWindow={() => {
    redirect.markCallbackWindow();
  }}
/>
<AuthPage
  {hasLoggedInBefore}
  title={isSetupRoute
    ? i18n.t('setup.title')
    : isAddingAccount
      ? i18n.t('common.addAccount')
      : undefined}
  status={core.status === 'starting' ||
  core.status === 'idle' ||
  (core.status === 'signed-out' && !hasCompletedInitialHomeserverCheck)
    ? i18n.t('common.startingSable')
    : undefined}
>
  {#if isSetupRoute}
    <SetupFlow />
  {:else}
    <AuthRail
      activeIndex={displayedStage}
      total={visibleFurthestStage + 1}
      canBack={displayedStage > 0}
      {canForward}
      onBack={back}
      onForward={forward}
    >
      <AuthStageCard
        active={displayedStage === 0}
        before={displayedStage > 0}
        onActivate={() => {
          activateStage(0);
        }}
      >
        <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
        {@render loginStageContent(canRegister)}
      </AuthStageCard>

      {#if canRegister && visibleFurthestStage >= 1}
        <AuthStageCard
          active={displayedStage === 1}
          after={displayedStage < 1}
          entering={enteringStage === 1}
          removing={retiringAfter === 0}
          onActivate={() => {
            activateStage(1);
          }}
          onMotionComplete={() => {
            completeStageMotion(retiringAfter ?? 1);
          }}
        >
          {#if signedIn}
            <AccountSummaryCard
              homeserver={flow.homeserver}
              {userId}
              onContinue={() => void openSetup()}
            />
          {:else}
            <RegistrationCard
              homeserver={flow.homeserver}
              registrationToken={registration.registrationToken}
              loginFlows={flow.loginFlows}
              registrationFlows={flow.registrationFlows}
              isCheckingHomeserver={flow.isCheckingHomeserver}
              {isRegistering}
              isEditingHomeserver={flow.isEditingHomeserver}
              fallback={registration.fallback}
              emailStep={registration.emailStep}
              username={registration.username}
              registrationEmail={registration.registrationEmail}
              password={registration.password}
              confirmPassword={registration.confirmPassword}
              error={registrationError}
              invalidRegistrationField={registration.invalidField}
              registrationFieldError={registration.fieldError}
              onHomeserverInput={(value: string) => {
                redirect.cleanup();
                flow.homeserverInput(value);
                login.resetForHomeserverChange();
                registration.resetForHomeserverChange();
              }}
              onRegistrationTokenInput={(value: string) => {
                registration.setToken(value);
              }}
              onValidateHomeserver={() => void flow.validateRegistrationHomeserver()}
              onClearFieldError={(field: Exclude<RegistrationField, 'homeserver'>) => {
                registration.clearFieldError(field);
              }}
              onStartRegistration={() => void registration.start()}
              onLaunchRedirectLogin={(type: 'oidc' | 'sso', id?: string) => {
                void redirect.launch(type, id, 'register');
              }}
              onOpenFallback={() => {
                registration.openFallback();
              }}
              onContinueFallback={() => void registration.continueFallback()}
              onRequestRegistrationEmail={(address: string) => {
                void registration.requestEmail(address);
              }}
              onSubmitRegistrationEmail={(token: string) => {
                void registration.submitEmail(token);
              }}
              onUsernameInput={(value: string) => {
                registration.setUsername(value);
              }}
              onRegistrationEmailInput={(value: string) => {
                registration.setEmail(value);
              }}
              onPasswordInput={(value: string) => {
                registration.setPassword(value);
              }}
              onConfirmPasswordInput={(value: string) => {
                registration.setConfirmPassword(value);
              }}
            />
            {#if redirect.pendingIntent === 'register'}
              {@render browserFallback()}
            {/if}
          {/if}
        </AuthStageCard>
      {/if}
    </AuthRail>
  {/if}
</AuthPage>

<DeviceVerificationDialog />

<QrLinkDialog
  bind:open={qrLoginOpen}
  mode="login"
  target={{
    homeserver: () => flow.homeserver.trim() || null,
    redirectUri: () => redirect.qrRedirectUri(),
  }}
  onSignedIn={async () => {
    loginPending = true;
    qrLoginOpen = false;
    markLoggedIn();
    await afterOverlayPops();
    await openSetup();
    loginPending = false;
  }}
/>

<style>
  .browser-fallback {
    color: var(--sec-main);
    font-size: var(--font-size-small);
    margin: var(--space-300) 0 var(--space-200);
  }
</style>
