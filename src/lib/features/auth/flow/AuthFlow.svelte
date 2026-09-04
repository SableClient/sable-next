<script lang="ts">
  import '#lib/features/auth/shared/auth-card.css';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import AuthFooter from '#lib/features/auth/shared/AuthFooter.svelte';
  import AuthHeader from '#lib/features/auth/shared/AuthHeader.svelte';
  import AuthRedirectBridge from './AuthRedirectBridge.svelte';
  import AuthRail from './AuthRail.svelte';
  import AuthStageCard from './AuthStageCard.svelte';
  import { furthestReachableStage, stageIndexForPath } from './stageRegistry';
  import { AuthFlowController, LOGGED_IN_MARKER, readReturningUser } from './auth-flow.svelte';
  import { LoginController, type LoginField } from '../login/login-controller.svelte';
  import LoginForm from '../login/LoginForm.svelte';
  import DeviceVerificationCard from '../login/DeviceVerificationCard.svelte';
  import DeviceVerificationDialog from '#lib/features/settings/DeviceVerificationDialog.svelte';
  import {
    RegistrationController,
    type RegistrationField,
  } from '../registration/registration-controller.svelte';
  import RegistrationCard from '../registration/RegistrationCard.svelte';
  import RecoverySetupCard from '../recovery/RecoverySetupCard.svelte';
  import AccountSummaryCard from '../profile/AccountSummaryCard.svelte';
  import { ProfileController, profileOnboardingMarker } from '../profile/profile-controller.svelte';
  import ProfileCard from '../profile/ProfileCard.svelte';
  import { RedirectController } from './redirect-controller.svelte';
  import { homeserverFromAuthUrl, registrationTokenFromAuthUrl } from './auth-url';
  import { homeservers } from '../shared/homeservers.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  const core = useCoreClient();
  const isAddingAccount = page.url.searchParams.has('addAccount');
  const stageRegistry = [
    {
      route: resolve('login'),
      completed: true,
      accessibilityLabel: 'auth.stageSignInLabel',
    },
    {
      route: resolve('register'),
      completed: false,
      accessibilityLabel: 'auth.stageCreateAccountLabel',
    },
    {
      route: resolve('register/recovery'),
      completed: false,
      accessibilityLabel: 'auth.stageRecoveryLabel',
    },
    {
      route: resolve('register/profile'),
      completed: false,
      accessibilityLabel: 'auth.stageProfileLabel',
    },
  ];

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
    Math.min(stageIndexForPath(page.url.pathname, stageRegistry), core.status === 'ready' ? 2 : 1)
  );
  let restoredMarkerFor: string | null = null;
  let lastUrlPrefill = '';
  let recoveryOnboardingComplete = $state(false);

  function markLoggedIn(): void {
    localStorage.setItem(LOGGED_IN_MARKER, 'true');
    hasLoggedInBefore = true;
  }

  function markOnboardingPending(matrixId: string): void {
    localStorage.setItem(
      profileOnboardingMarker(matrixId),
      JSON.stringify({ stage: 'recovery', homeserver: flow.homeserver })
    );
  }

  const redirect = new RedirectController({
    core,
    getHomeserver: () => flow.homeserver,
    getValidationError: () => flow.error,
    validateHomeserver: () => flow.validateHomeserver(0),
    onMarkLoggedIn: markLoggedIn,
    onMarkOnboardingPending: markOnboardingPending,
    onNavigateLoginVerification: navigateToLoginVerification,
    onNavigateRegistrationRecovery: () => goto(resolve('register/recovery')),
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
      onRegistrationComplete: () => goto(resolve('register/recovery')),
      onOpenFallback: (fallback, onComplete) => {
        redirect.openFallback(fallback, onComplete);
      },
    },
    registrationTokenFromAuthUrl(page.url)
  );

  const profile = new ProfileController({
    core,
    getUserId: () => core.session?.user_id ?? '',
    onNavigateHome: () => goto(resolve('/(app)/rooms')),
  });

  const login = new LoginController({
    core,
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

  let requestedStage = $derived(stageIndexForPath(page.url.pathname, stageRegistry));
  let stages = $derived(
    stageRegistry.map((stage, index) => ({
      ...stage,
      completed:
        index === 0 ||
        (index === 1 && core.status === 'ready') ||
        (index === 2 && recoveryOnboardingComplete),
    }))
  );

  let activeIndex = $derived(furthestReachableStage(requestedStage, stages));
  let hasSecondaryStage = $derived(
    furthestReached >= 1 || core.status === 'signed-out' || isAddingAccount
  );
  let visibleFurthestStage = $derived(
    hasSecondaryStage ? Math.max(furthestReached, 1) : furthestReached
  );
  let isProfileStage = $derived(activeIndex === 3);
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
  let loginVerificationPending = $state(false);
  let isDeviceVerificationStage = $derived(page.url.pathname === resolve('login/verify'));
  let loginVerificationActive = $state(page.url.pathname === resolve('login/verify'));
  let verificationDisplayedStage = $derived(isDeviceVerificationStage ? 1 : 0);
  let carouselDisplayedStage = $derived(
    loginVerificationActive ? verificationDisplayedStage : displayedStage
  );
  let carouselTotal = $derived(loginVerificationActive ? 2 : visibleFurthestStage + 1);
  let carouselCanForward = $derived(
    loginVerificationActive
      ? verificationDisplayedStage === 0
      : displayedStage < furthestReached ||
          (displayedStage === 0 && hasSecondaryStage) ||
          (displayedStage === 1 && core.status === 'ready') ||
          (displayedStage === 2 && recoveryOnboardingComplete)
  );

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
    void untrack(() =>
      flow.validateHomeserver(displayedStage).finally(() => {
        hasCompletedInitialHomeserverCheck = true;
      })
    );
  });

  $effect(() => {
    if (requestedStage < 2 || core.status !== 'signed-out') return;
    void goto(resolve('register'));
  });

  $effect(() => {
    if (isDeviceVerificationStage && core.status === 'signed-out') {
      loginVerificationActive = false;
      void goto(resolve('login'));
    }
  });

  $effect(() => {
    if (core.status !== 'ready' || !userId || pendingOnboardingTransition) return;
    if (loginVerificationActive || loginVerificationPending) return;
    if (redirect.pendingIntent === 'login' && redirect.isCompleting) return;
    const rawMarker = localStorage.getItem(profileOnboardingMarker(userId));
    if (!rawMarker) {
      void goto(resolve('/(app)/rooms'));
      return;
    }
    if (restoredMarkerFor === userId) return;
    restoredMarkerFor = userId;
    try {
      const marker = JSON.parse(rawMarker) as { homeserver?: string; stage?: string };
      if (marker.homeserver) flow.homeserver = marker.homeserver;
      if (marker.stage === 'profile') recoveryOnboardingComplete = true;
    } catch {
      return;
    }
  });

  async function signInWithPassword(): Promise<void> {
    loginVerificationPending = true;
    await login.login();
    if (core.status === 'ready') {
      await navigateToLoginVerification();
    } else {
      loginVerificationPending = false;
    }
  }

  async function navigateToLoginVerification(): Promise<void> {
    loginVerificationActive = true;
    await goto(resolve('login/verify'), { reset: false });
    loginVerificationPending = false;
  }

  function showLoginStage(): void {
    void goto(resolve('login'), { reset: false });
  }

  function showRegistrationStage(): void {
    activateStage(1);
  }

  function finishLoginVerification(): void {
    loginVerificationActive = false;
    loginVerificationPending = false;
    void goto(resolve('/(app)/rooms'));
  }

  function finishRecoveryOnboarding(): void {
    if (!userId) return;
    localStorage.setItem(
      profileOnboardingMarker(userId),
      JSON.stringify({ stage: 'profile', homeserver: flow.homeserver })
    );
    recoveryOnboardingComplete = true;
    activateStage(3);
  }

  function carouselBack(): void {
    if (loginVerificationActive) showLoginStage();
    else back();
  }

  function carouselForward(): void {
    if (loginVerificationActive) void navigateToLoginVerification();
    else forward();
  }

  function activateCarouselStage(index: number): void {
    if (!loginVerificationActive) {
      activateStage(index);
      return;
    }
    if (index === 0) showLoginStage();
    else void navigateToLoginVerification();
  }

  onMount(() => {
    hasLoggedInBefore = readReturningUser(localStorage);
    return () => {
      redirect.cleanup();
      profile.cleanup();
      if (!redirect.isCallbackWindow)
        void core.commands.cancelRegistration().catch(() => undefined);
    };
  });

  function back(): void {
    if (displayedStage <= 0) return;
    activateStage(Math.max(0, displayedStage - 1));
  }

  function forward(): void {
    if (displayedStage < furthestReached) activateStage(displayedStage + 1);
    else if (displayedStage === 0 && hasSecondaryStage) activateStage(1);
    else if (displayedStage === 1 && core.status === 'ready') activateStage(2);
    else if (displayedStage === 2 && recoveryOnboardingComplete) activateStage(3);
  }

  function activateStage(index: number): void {
    if (index === displayedStage || pendingStage !== null || retiringAfter !== null) return;
    if (index < 0 || index >= stageRegistry.length) return;
    if (index > furthestReached) {
      furthestReached = index;
      enteringStage = index;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) enteringStage = null;
    }
    pendingStage = index;
    void goto(stageRoute(index), { reset: false }).finally(() => {
      pendingStage = null;
    });
  }

  function stageRoute(index: number): string {
    const base = stageRegistry[index].route;
    if (index > 1) return base;
    const server = flow.homeserver.trim();
    const route =
      server &&
      server !== homeservers.default &&
      !server.includes('/') &&
      !server.includes('?') &&
      !server.includes('#')
        ? `${base}/${encodeURIComponent(server)}`
        : base;
    if (index !== 1 || !registration.registrationToken?.trim()) return route;
    return `${route}?registration_token=${encodeURIComponent(registration.registrationToken.trim())}`;
  }

  function invalidateAfter(index: number): void {
    if (furthestReached <= index || retiringAfter !== null) return;
    retiringAfter = index;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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

<svelte:head>
  <title>
    {$i18n.t(
      isDeviceVerificationStage
        ? 'auth.verifyDevice'
        : displayedStage === 0
          ? 'auth.signInTitle'
          : displayedStage === 2
            ? 'auth.setUpRecovery'
            : displayedStage === 3
              ? 'auth.makeItYours'
              : 'auth.createAccount'
    )} - Sable
  </title>
</svelte:head>

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
    onCreateAccount={showCreateAccount ? showRegistrationStage : undefined}
  />
{/snippet}

<main class="auth-page">
  <AuthRedirectBridge
    onCallback={(url: string) => {
      void redirect.complete(url);
    }}
    onRegistrationComplete={() => {
      void core.start().then(() => {
        if (core.status === 'ready') void goto(resolve('register/recovery'));
      });
    }}
    onCallbackWindow={() => {
      redirect.markCallbackWindow();
    }}
  />
  <section class="auth-content" aria-labelledby="sable-title">
    <AuthHeader {hasLoggedInBefore} />
    <div class="auth-main">
      {#if core.status === 'starting' || core.status === 'idle' || (core.status === 'signed-out' && !hasCompletedInitialHomeserverCheck)}
        <div class="bootstrap">
          <Spinner />
          <p>{$i18n.t('auth.starting')}</p>
        </div>
      {:else}
        <AuthRail
          activeIndex={carouselDisplayedStage}
          total={carouselTotal}
          canBack={carouselDisplayedStage > 0}
          canForward={carouselCanForward}
          onBack={carouselBack}
          onForward={carouselForward}
        >
          <AuthStageCard
            active={carouselDisplayedStage === 0}
            before={carouselDisplayedStage > 0}
            accessibilityLabel={$i18n.t(stages[0].accessibilityLabel)}
            onActivate={() => {
              activateCarouselStage(0);
            }}
          >
            <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -->
            {@render loginStageContent(!loginVerificationActive)}
          </AuthStageCard>

          {#if loginVerificationActive || visibleFurthestStage >= 1}
            <AuthStageCard
              active={carouselDisplayedStage === 1}
              before={carouselDisplayedStage > 1}
              after={carouselDisplayedStage < 1}
              entering={!loginVerificationActive && enteringStage === 1}
              removing={!loginVerificationActive && retiringAfter === 0}
              accessibilityLabel={loginVerificationActive
                ? $i18n.t('auth.verifyDevice')
                : $i18n.t(stages[1].accessibilityLabel)}
              onActivate={() => {
                activateCarouselStage(1);
              }}
              onMotionComplete={() => {
                if (!loginVerificationActive) completeStageMotion(retiringAfter ?? 1);
              }}
            >
              {#if loginVerificationActive}
                <DeviceVerificationCard
                  onComplete={finishLoginVerification}
                  onSkip={finishLoginVerification}
                />
              {:else if displayedStage >= 2 || core.status === 'ready'}
                <AccountSummaryCard
                  homeserver={flow.homeserver}
                  {userId}
                  onContinue={() => {
                    activateStage(2);
                  }}
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
              {/if}
            </AuthStageCard>
          {/if}

          {#if !loginVerificationActive && furthestReached >= 2}
            <AuthStageCard
              active={displayedStage === 2}
              before={displayedStage > 2}
              after={displayedStage < 2}
              entering={enteringStage === 2}
              removing={retiringAfter !== null && retiringAfter < 2}
              accessibilityLabel={$i18n.t(stages[2].accessibilityLabel)}
              onActivate={() => {
                activateStage(2);
              }}
              onMotionComplete={() => {
                completeStageMotion(retiringAfter ?? 2);
              }}
            >
              <RecoverySetupCard
                onComplete={finishRecoveryOnboarding}
                onSkip={finishRecoveryOnboarding}
              />
            </AuthStageCard>
          {/if}

          {#if !loginVerificationActive && furthestReached >= 3}
            <AuthStageCard
              active={displayedStage === 3}
              before={displayedStage > 3}
              after={displayedStage < 3}
              entering={enteringStage === 3}
              removing={retiringAfter !== null && retiringAfter < 3}
              accessibilityLabel={$i18n.t(stages[3].accessibilityLabel)}
              onActivate={() => {
                activateStage(3);
              }}
              onMotionComplete={() => {
                completeStageMotion(retiringAfter ?? 3);
              }}
            >
              <ProfileCard
                {userId}
                displayName={profile.displayName}
                avatarPreview={profile.avatarPreview}
                isSaving={profile.isSaving}
                error={isProfileStage ? profile.error : null}
                onDisplayName={(value: string) => {
                  profile.setDisplayName(value);
                }}
                onAvatar={(file: File | null) => {
                  profile.setAvatar(file);
                }}
                onContinue={() => void profile.save()}
                onSkip={() => void profile.skip()}
              />
            </AuthStageCard>
          {/if}
        </AuthRail>
      {/if}
    </div>
  </section>
  <AuthFooter />
</main>

<DeviceVerificationDialog />

<style>
  .auth-page {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding: var(--space-700) var(--space-600);
    padding-block: calc(var(--space-700) + var(--safe-top))
      calc(var(--space-700) + var(--safe-bottom));
  }

  .auth-content {
    display: grid;
    flex: 1 0 auto;
    grid-template-rows: calc((100dvh - 4rem) / 3) auto;
    margin: 0 auto;
    max-width: 78rem;
    width: 100%;
  }

  .auth-main {
    align-self: start;
    min-width: 0;
    padding-bottom: var(--space-800);
  }

  .bootstrap {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: center;
  }

  .bootstrap p {
    margin: 0;
  }
</style>
