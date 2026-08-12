<script lang="ts">
  import '$lib/features/auth/shared/auth-card.css';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { i18n } from '$lib/i18n';
  import { useCoreClient } from '$lib/core/context';
  import AuthFooter from '$lib/features/auth/shared/AuthFooter.svelte';
  import AuthHeader from '$lib/features/auth/shared/AuthHeader.svelte';
  import AuthRedirectBridge from './AuthRedirectBridge.svelte';
  import AuthRail from './AuthRail.svelte';
  import AuthStageCard from './AuthStageCard.svelte';
  import { furthestReachableStage, stageIndexForPath } from './stageRegistry';
  import { AuthFlowController, LOGGED_IN_MARKER, readReturningUser } from './auth-flow.svelte';
  import { LoginController, type LoginField } from '../login/login-controller.svelte';
  import LoginForm from '../login/LoginForm.svelte';
  import {
    RegistrationController,
    type RegistrationField,
  } from '../registration/registration-controller.svelte';
  import RegistrationCard from '../registration/RegistrationCard.svelte';
  import AccountSummaryCard from '../profile/AccountSummaryCard.svelte';
  import { ProfileController, profileOnboardingMarker } from '../profile/profile-controller.svelte';
  import ProfileCard from '../profile/ProfileCard.svelte';
  import { RedirectController } from './redirect-controller.svelte';
  import { homeserverFromAuthUrl, registrationTokenFromAuthUrl } from './auth-url';
  import { DEFAULT_HOMESERVER } from '../shared/homeservers';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';

  const core = useCoreClient();
  const isAddingAccount = page.url.searchParams.has('addAccount');
  const stageRegistry = [
    {
      route: resolve('/login'),
      title: 'Sign in',
      completed: true,
      accessibilityLabel: 'Sign in to Sable',
    },
    {
      route: resolve('/register'),
      title: 'Create account',
      completed: false,
      accessibilityLabel: 'Create your Matrix account',
    },
    {
      route: resolve('/register/profile'),
      title: 'Profile setup',
      completed: false,
      accessibilityLabel: 'Choose your profile details',
    },
  ];

  const flow = new AuthFlowController(
    core,
    homeserverFromAuthUrl(page.url) ?? DEFAULT_HOMESERVER,
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

  function markLoggedIn(): void {
    localStorage.setItem(LOGGED_IN_MARKER, 'true');
    hasLoggedInBefore = true;
  }

  function markOnboardingPending(matrixId: string): void {
    localStorage.setItem(
      profileOnboardingMarker(matrixId),
      JSON.stringify({ stage: 'profile', homeserver: flow.homeserver })
    );
  }

  const redirect = new RedirectController({
    core,
    getHomeserver: () => flow.homeserver,
    getValidationError: () => flow.error,
    validateHomeserver: () => flow.validateHomeserver(0),
    onMarkLoggedIn: markLoggedIn,
    onMarkOnboardingPending: markOnboardingPending,
    onNavigateHome: () => goto(resolve('/home')),
    onNavigateProfile: () => goto(resolve('/register/profile')),
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
      onRegistrationComplete: () => goto(resolve('/register/profile')),
      onOpenFallback: (fallback, onComplete) => {
        redirect.openFallback(fallback, onComplete);
      },
    },
    registrationTokenFromAuthUrl(page.url)
  );

  const profile = new ProfileController({
    core,
    getUserId: () => core.session?.user_id ?? '',
    onNavigateHome: () => goto(resolve('/home')),
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
      completed: index === 0 || (index === 1 && core.status === 'ready'),
    }))
  );
  let activeIndex = $derived(furthestReachableStage(requestedStage, stages));
  let isProfileStage = $derived(activeIndex === 2);
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

  $effect(() => {
    if (flow.shouldValidateRegistration(displayedStage, hasCompletedInitialHomeserverCheck)) {
      void flow.validateRegistrationHomeserver();
    }
  });

  $effect(() => {
    if (typeof window !== 'undefined') hasLoggedInBefore = readReturningUser(localStorage);
  });

  $effect(() => {
    const urlKey = `${page.url.pathname}${page.url.search}`;
    if (urlKey === lastUrlPrefill) return;
    lastUrlPrefill = urlKey;
    const urlHomeserver = homeserverFromAuthUrl(page.url);
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
    if (pendingStage !== null && pendingStage === activeIndex) pendingStage = null;
  });

  $effect(() => {
    if (activeIndex > furthestReached) furthestReached = activeIndex;
  });

  $effect(() => {
    if ((!isAddingAccount && core.status !== 'signed-out') || initialized) return;
    initialized = true;
    void flow.validateHomeserver(displayedStage).finally(() => {
      hasCompletedInitialHomeserverCheck = true;
    });
  });

  $effect(() => {
    if (
      requestedStage !== 2 ||
      isProfileStage ||
      (!isAddingAccount && core.status !== 'signed-out')
    )
      return;
    void goto(resolve('/register'));
  });

  $effect(() => {
    if (core.status !== 'ready' || !userId || pendingOnboardingTransition) return;
    const rawMarker = localStorage.getItem(profileOnboardingMarker(userId));
    if (!rawMarker) {
      void goto(resolve('/home'));
      return;
    }
    if (restoredMarkerFor === userId) return;
    restoredMarkerFor = userId;
    try {
      const marker = JSON.parse(rawMarker) as { homeserver?: string };
      if (marker.homeserver) flow.homeserver = marker.homeserver;
    } catch {
      return;
    }
  });

  onMount(() => {
    return () => {
      redirect.cleanup();
      profile.cleanup();
      if (!redirect.isCallbackWindow) void core.cancelRegistration().catch(() => undefined);
    };
  });

  function back(): void {
    if (displayedStage <= 0) return;
    activateStage(Math.max(0, displayedStage - 1));
  }

  function forward(): void {
    if (displayedStage < furthestReached) activateStage(displayedStage + 1);
    else if (displayedStage === 1 && core.status === 'ready') activateStage(2);
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
    void goto(resolve(stageRoute(index) as '/login' | '/register' | '/register/profile'), {
      keepFocus: true,
      noScroll: true,
    });
  }

  function stageRoute(index: number): string {
    const base = stageRegistry[index].route;
    if (index > 1) return base;
    const server = flow.homeserver.trim();
    const route =
      server &&
      server !== DEFAULT_HOMESERVER &&
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
    {$i18n.t(displayedStage === 0 ? 'auth.signInTitle' : 'auth.createAccount')} - Sable
  </title>
</svelte:head>

<main class="auth-page">
  <AuthRedirectBridge
    onCallback={(url: string) => {
      void redirect.complete(url);
    }}
    onRegistrationComplete={() => {
      void core.start().then(() => {
        if (core.status === 'ready') void goto(resolve('/register/profile'));
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
          activeIndex={displayedStage}
          total={furthestReached + 1}
          canBack={displayedStage > 0}
          canForward={displayedStage < furthestReached ||
            (displayedStage === 1 && core.status === 'ready')}
          onBack={back}
          onForward={forward}
        >
          <AuthStageCard
            active={displayedStage === 0}
            before={displayedStage > 0}
            accessibilityLabel={stages[0].accessibilityLabel}
            onActivate={() => {
              activateStage(0);
            }}
          >
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
              onLogin={() => login.login()}
              onCreateAccount={() => {
                activateStage(1);
              }}
            />
          </AuthStageCard>

          {#if furthestReached >= 1}
            <AuthStageCard
              active={displayedStage === 1}
              before={displayedStage > 1}
              after={displayedStage < 1}
              entering={enteringStage === 1}
              removing={retiringAfter === 0}
              accessibilityLabel={stages[1].accessibilityLabel}
              onActivate={() => {
                activateStage(1);
              }}
              onMotionComplete={() => {
                completeStageMotion(retiringAfter ?? 1);
              }}
            >
              {#if isProfileStage || core.status === 'ready'}
                <AccountSummaryCard
                  homeserver={flow.homeserver}
                  {userId}
                  onSetUpProfile={() => {
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

          {#if furthestReached >= 2}
            <AuthStageCard
              active={displayedStage === 2}
              before={displayedStage > 2}
              after={displayedStage < 2}
              entering={enteringStage === 2}
              removing={retiringAfter !== null && retiringAfter < 2}
              accessibilityLabel={stages[2].accessibilityLabel}
              onActivate={() => {
                activateStage(2);
              }}
              onMotionComplete={() => {
                completeStageMotion(retiringAfter ?? 2);
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
    max-width: 78rem;
    width: 100%;
  }

  .auth-main {
    align-self: start;
    min-width: 0;
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
