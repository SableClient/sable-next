<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';

  import type { EncryptionStatusView } from '#src/generated/protocol';
  import { takeAfterLogin } from '#lib/auth/after-login.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { permissionState } from '#lib/features/notifications/present.js';
  import { i18n } from '#lib/i18n.js';
  import { telemetryConsentPending } from '#lib/platform/telemetry.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TelemetryConsentCard from '../consent/TelemetryConsentCard.svelte';
  import AuthRail from '../flow/AuthRail.svelte';
  import AuthStageCard from '../flow/AuthStageCard.svelte';
  import ProfileCard from '../profile/ProfileCard.svelte';
  import { ProfileController, profileOnboardingMarker } from '../profile/profile-controller.svelte';
  import RecoverySetupCard from '../recovery/RecoverySetupCard.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import ConfirmDeviceCard from './ConfirmDeviceCard.svelte';
  import NotificationsSetupCard from './NotificationsSetupCard.svelte';
  import AppearanceSetupCard from './AppearanceSetupCard.svelte';
  import ChatStyleSetupCard from './ChatStyleSetupCard.svelte';
  import SettingsSyncCard from './SettingsSyncCard.svelte';
  import SetupDoneCard from './SetupDoneCard.svelte';
  import {
    encryptionKnown,
    isAccountStep,
    replan,
    setupNeeded,
    type AccountStep,
    type SetupState,
    type SetupStep,
  } from './setup-plan';
  import {
    markAccountFinished,
    pendingStep,
    readAccountFinished,
    readSetupRecord,
    setupRecordKey,
    writeSetupRecord,
    type SetupRecord,
  } from './setup-record';

  const STAGE_LABELS: Record<SetupStep, string> = {
    device: 'setup.stageDeviceLabel',
    recovery: 'auth.stageRecoveryLabel',
    profile: 'auth.stageProfileLabel',
    notifications: 'setup.stageNotificationsLabel',
    appearance: 'setup.stageAppearanceLabel',
    layout: 'setup.stageLayoutLabel',
    sync: 'setup.stageSyncLabel',
    done: 'setup.stageDoneLabel',
    consent: 'auth.stageConsentLabel',
  };

  const core = useCoreClient();
  let record = $state<SetupRecord | null>(null);
  let accountFinished = $state.raw<AccountStep[]>([]);
  let permissionAskable = false;
  let newRecoveryKey = $state<string | null>(null);
  let started = false;
  let leaving = false;

  const userId = $derived(core.session?.user_id ?? '');
  const deviceId = $derived(core.session?.device_id ?? '');
  const recordKey = $derived(userId && deviceId ? setupRecordKey(userId, deviceId) : null);
  const steps = $derived(record?.steps ?? []);
  const pending = $derived(record ? pendingStep(record) : null);
  const pendingIndex = $derived(pending ? steps.indexOf(pending) : steps.length - 1);
  const requested = $derived(page.url.pathname.split('/').filter(Boolean).at(-1) ?? '');
  const requestedIndex = $derived(steps.indexOf(requested as SetupStep));
  const activeIndex = $derived(
    requestedIndex >= 0 && requestedIndex <= pendingIndex ? requestedIndex : pendingIndex
  );
  const canSkipAhead = $derived(
    pending !== null &&
      ['profile', 'notifications', 'appearance', 'layout', 'sync'].includes(pending)
  );

  const profile = new ProfileController({
    core,
    getUserId: () => userId,
    onNavigateHome: () => {
      advance('profile');
      return Promise.resolve();
    },
  });

  onMount(() => () => {
    profile.cleanup();
  });

  function stepRoute(step: SetupStep): string {
    return resolve('/(auth)/setup/[step]', { step });
  }

  function stateFor(base: Pick<SetupRecord, 'registering'>, encryption: EncryptionStatusView) {
    return {
      registering: base.registering,
      verification: encryption.verification,
      recovery: encryption.recovery,
      newRecoveryKey: newRecoveryKey !== null,
      accountFinished,
      permissionAskable,
      syncEnabled: preferences.settingsSync,
      consentPending: telemetryConsentPending(),
    } satisfies SetupState;
  }

  function freshRecord(encryption: EncryptionStatusView): SetupRecord {
    const marker = localStorage.getItem(profileOnboardingMarker(userId));
    let homeserver = '';
    try {
      const parsed = JSON.parse(marker ?? 'null') as { homeserver?: unknown } | null;
      if (typeof parsed?.homeserver === 'string') homeserver = parsed.homeserver;
    } catch {
      homeserver = '';
    }
    const registering = marker !== null;
    return {
      full: setupNeeded(stateFor({ registering }, encryption)),
      registering,
      homeserver,
      steps: [],
      finished: [],
    };
  }

  async function start(key: string, encryption: EncryptionStatusView): Promise<void> {
    [accountFinished, permissionAskable] = await Promise.all([
      readAccountFinished(core).catch((error: unknown) => {
        console.warn('[sable setup] account progress unavailable', error);
        return [];
      }),
      permissionState().then((state) => state === 'prompt'),
    ]);
    const base = readSetupRecord(localStorage, key) ?? freshRecord(encryption);
    localStorage.removeItem(profileOnboardingMarker(userId));
    settle(key, base);
  }

  function settle(key: string, base: SetupRecord, reload = false): void {
    const encryption = core.encryption;
    const next = encryption
      ? { ...base, steps: replan(base.finished, stateFor(base, encryption), base.full) }
      : base;
    const upcoming = pendingStep(next);
    if (!upcoming) {
      localStorage.removeItem(key);
      leave(takeAfterLogin(resolve('/(app)/rooms')), reload);
      return;
    }
    writeSetupRecord(localStorage, key, next);
    record = next;
    const target = stepRoute(upcoming);
    if (reload) location.assign(target);
    else if (page.url.pathname !== target)
      void goto(target, { replaceState: requestedIndex < 0, reset: false });
  }

  function leave(target: string, reload: boolean): void {
    leaving = true;
    if (reload) location.assign(target);
    else void goto(target);
  }

  function advance(step: SetupStep, reload = false): void {
    if (!record || !recordKey) return;
    const finished = record.finished.includes(step) ? record.finished : [...record.finished, step];
    if (isAccountStep(step) && !accountFinished.includes(step)) {
      accountFinished = [...accountFinished, step];
      void markAccountFinished(core, step).catch((error: unknown) => {
        console.warn('[sable setup] account progress was not saved', error);
      });
    }
    settle(recordKey, { ...record, finished }, reload);
  }

  function activate(index: number): void {
    const step = steps.at(index);
    if (!step) return;
    if (index <= pendingIndex) void goto(stepRoute(step), { reset: false });
    else if (index === pendingIndex + 1 && canSkipAhead && pending) advance(pending);
  }

  function skipChecking(): void {
    void goto(takeAfterLogin(resolve('/(app)/rooms')));
  }

  $effect(() => {
    if (core.status === 'signed-out') void goto(resolve('login'));
  });

  $effect(() => {
    const encryption = core.encryption;
    if (core.status !== 'ready' || !recordKey || !encryption || !encryptionKnown(encryption)) {
      return;
    }
    if (untrack(() => started)) return;
    started = true;
    void untrack(() => start(recordKey, encryption));
  });

  $effect(() => {
    if (!record || !pending || leaving) return;
    if (requestedIndex >= 0 && requestedIndex <= pendingIndex) return;
    void goto(stepRoute(pending), { replaceState: true, reset: false });
  });
</script>

{#if !record}
  <div class="setup-checking" role="status">
    <Spinner />
    <p>{$i18n.t('setup.checking')}</p>
  </div>
  <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={skipChecking} />
{:else}
  <AuthRail
    {activeIndex}
    total={steps.length}
    canBack={activeIndex > 0}
    canForward={activeIndex < pendingIndex || (activeIndex === pendingIndex && canSkipAhead)}
    progress={steps.length > 1
      ? $i18n.t('setup.progress', { current: activeIndex + 1, total: steps.length })
      : undefined}
    onBack={() => {
      activate(activeIndex - 1);
    }}
    onForward={() => {
      activate(activeIndex + 1);
    }}
  >
    {#each steps as step, index (step)}
      <AuthStageCard
        active={index === activeIndex}
        reachable={index <= pendingIndex || (index === pendingIndex + 1 && canSkipAhead)}
        before={index < activeIndex}
        after={index > activeIndex}
        accessibilityLabel={$i18n.t(STAGE_LABELS[step])}
        unavailableLabel={$i18n.t('setup.finishCurrentStep')}
        onActivate={() => {
          activate(index);
        }}
      >
        {#if step === 'device'}
          <ConfirmDeviceCard
            onComplete={() => {
              advance('device');
            }}
            onSkip={() => {
              advance('device');
            }}
            onReset={(recoveryKey: string) => {
              newRecoveryKey = recoveryKey;
              advance('device');
            }}
          />
        {:else if step === 'recovery'}
          <RecoverySetupCard
            recoveryKey={newRecoveryKey}
            onComplete={() => {
              newRecoveryKey = null;
              advance('recovery');
            }}
            onSkip={() => {
              advance('recovery');
            }}
          />
        {:else if step === 'notifications'}
          <NotificationsSetupCard
            askDefault={!accountFinished.includes('notifications')}
            onComplete={() => {
              permissionAskable = false;
              advance('notifications');
            }}
            onSkip={() => {
              permissionAskable = false;
              advance('notifications');
            }}
          />
        {:else if step === 'appearance'}
          <AppearanceSetupCard
            onComplete={() => {
              advance('appearance');
            }}
          />
        {:else if step === 'layout'}
          <ChatStyleSetupCard onComplete={() => advance('layout')} />
        {:else if step === 'sync'}
          <SettingsSyncCard
            onComplete={() => {
              advance('sync');
            }}
            onSkip={() => {
              advance('sync');
            }}
          />
        {:else if step === 'done'}
          <SetupDoneCard
            active={index === activeIndex}
            onComplete={() => {
              advance('done');
            }}
          />
        {:else if step === 'profile'}
          <ProfileCard
            {userId}
            displayName={profile.displayName}
            pronouns={profile.pronouns}
            nameColor={profile.nameColor}
            status={profile.status}
            bannerPreview={profile.bannerPreview}
            avatarPreview={profile.avatarPreview}
            isSaving={profile.isSaving}
            error={index === activeIndex ? profile.error : null}
            onDisplayName={(value: string) => {
              profile.setDisplayName(value);
            }}
            onPronouns={(value: string) => {
              profile.setPronouns(value);
            }}
            onNameColor={(value: string) => {
              profile.setNameColor(value);
            }}
            onStatus={(value: string) => {
              profile.setStatus(value);
            }}
            onBanner={(file: File | null) => {
              profile.setBanner(file);
            }}
            onAvatar={(file: File | null) => {
              profile.setAvatar(file);
            }}
            onContinue={() => void profile.save()}
            onSkip={() => void profile.skip()}
          />
        {:else}
          <TelemetryConsentCard
            onAnswer={(enabled: boolean) => {
              advance('consent', enabled);
            }}
          />
        {/if}
      </AuthStageCard>
    {/each}
  </AuthRail>
{/if}

<style>
  .setup-checking {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: center;
  }

  .setup-checking p {
    margin: 0;
  }
</style>
