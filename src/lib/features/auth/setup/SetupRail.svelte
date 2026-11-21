<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import TelemetryConsentCard from '../consent/TelemetryConsentCard.svelte';
  import AuthRail from '../flow/AuthRail.svelte';
  import AuthStageCard from '../flow/AuthStageCard.svelte';
  import ProfileCard from '../profile/ProfileCard.svelte';
  import type { ProfileController } from '../profile/profile-controller.svelte';
  import RecoverySetupCard from '../recovery/RecoverySetupCard.svelte';
  import AppearanceSetupCard from './AppearanceSetupCard.svelte';
  import ChatStyleSetupCard from './ChatStyleSetupCard.svelte';
  import ConfirmDeviceCard from './ConfirmDeviceCard.svelte';
  import NotificationsSetupCard from './NotificationsSetupCard.svelte';
  import SettingsSyncCard from './SettingsSyncCard.svelte';
  import SetupActions, { type SkipAction } from './SetupActions.svelte';
  import SetupDoneCard from './SetupDoneCard.svelte';
  import type { SetupStep } from './setup-plan';

  interface Props {
    steps: readonly SetupStep[];
    activeIndex: number;
    pendingIndex: number;
    canSkipAhead: boolean;
    userId: string;
    profile: ProfileController;
    askNotificationDefault: boolean;
    newRecoveryKey?: string | null;
    loggingOut?: boolean;
    logoutFailed?: boolean;
    onActivate: (index: number) => void;
    onAdvance: (step: SetupStep, reload?: boolean) => void;
    onLogout: () => void;
  }

  let {
    steps,
    activeIndex,
    pendingIndex,
    canSkipAhead,
    userId,
    profile,
    askNotificationDefault,
    newRecoveryKey = $bindable(null),
    loggingOut = false,
    logoutFailed = false,
    onActivate,
    onAdvance,
    onLogout,
  }: Props = $props();
  const core = useCoreClient();
  let createdRecoveryKey = $state('');
  let deviceView = $state<'choices' | 'recovery' | 'reset' | 'skip'>('choices');
  let devicePrompted = $state(false);
  let notificationsSaving = $state(false);

  const pending = $derived(steps.at(pendingIndex));
  const skip = $derived.by((): SkipAction | null => {
    if (activeIndex !== pendingIndex) return null;
    switch (pending) {
      case 'device':
        return devicePrompted &&
          core.encryption?.verification !== 'verified' &&
          deviceView === 'choices'
          ? { onclick: () => (deviceView = 'skip') }
          : null;
      case 'recovery':
        return createdRecoveryKey || newRecoveryKey
          ? null
          : { onclick: () => onAdvance('recovery') };
      case 'notifications':
        return { onclick: () => onAdvance('notifications'), disabled: notificationsSaving };
      case 'profile':
        return { onclick: () => void profile.skip(), disabled: profile.isSaving };
      case 'appearance':
      case 'layout':
      case 'sync':
        return { onclick: () => onAdvance(pending) };
      default:
        return null;
    }
  });
</script>

<AuthRail
  {activeIndex}
  total={steps.length}
  canBack={activeIndex > 0}
  canForward={activeIndex < pendingIndex || (activeIndex === pendingIndex && canSkipAhead)}
  progress={steps.length > 1
    ? i18n.t('setup.progress', { current: activeIndex + 1, total: steps.length })
    : undefined}
  onBack={() => {
    onActivate(activeIndex - 1);
  }}
  onForward={() => {
    onActivate(activeIndex + 1);
  }}
>
  {#each steps as step, index (step)}
    <AuthStageCard
      active={index === activeIndex}
      reachable={index <= pendingIndex || (index === pendingIndex + 1 && canSkipAhead)}
      before={index < activeIndex}
      after={index > activeIndex}
      unavailableLabel={i18n.t('setup.finishCurrentStep')}
      onActivate={() => {
        onActivate(index);
      }}
    >
      {#if step === 'device'}
        <ConfirmDeviceCard
          bind:view={deviceView}
          bind:prompted={devicePrompted}
          onComplete={() => {
            onAdvance('device');
          }}
          onSkip={() => {
            onAdvance('device');
          }}
          onReset={(recoveryKey: string) => {
            newRecoveryKey = recoveryKey;
            onAdvance('device');
          }}
        />
      {:else if step === 'recovery'}
        <RecoverySetupCard
          recoveryKey={newRecoveryKey}
          bind:createdKey={createdRecoveryKey}
          onComplete={() => {
            newRecoveryKey = null;
            onAdvance('recovery');
          }}
        />
      {:else if step === 'notifications'}
        <NotificationsSetupCard
          askDefault={askNotificationDefault}
          bind:saving={notificationsSaving}
          onComplete={() => {
            onAdvance('notifications');
          }}
        />
      {:else if step === 'appearance'}
        <AppearanceSetupCard
          onComplete={() => {
            onAdvance('appearance');
          }}
        />
      {:else if step === 'layout'}
        <ChatStyleSetupCard onComplete={() => onAdvance('layout')} />
      {:else if step === 'sync'}
        <SettingsSyncCard
          onComplete={() => {
            onAdvance('sync');
          }}
        />
      {:else if step === 'done'}
        <SetupDoneCard
          active={index === activeIndex}
          onComplete={() => {
            onAdvance('done');
          }}
        />
      {:else if step === 'profile'}
        <ProfileCard
          {userId}
          displayName={profile.displayName}
          pronouns={profile.pronouns}
          nameColor={profile.nameColor}
          status={profile.status}
          bannerPreview={profile.shownBanner}
          avatarPreview={profile.shownAvatar}
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
        />
      {:else}
        <TelemetryConsentCard
          onAnswer={(enabled: boolean) => {
            onAdvance('consent', enabled);
          }}
        />
      {/if}
    </AuthStageCard>
  {/each}
</AuthRail>
<SetupActions {skip} {loggingOut} {logoutFailed} {onLogout} />
