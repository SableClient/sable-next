<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient, useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { ProfileController } from '../profile/profile-controller.svelte';
  import AuthPage from '../shared/AuthPage.svelte';
  import '../shared/auth-card.css';
  import SetupRail from './SetupRail.svelte';
  import type { SetupStep } from './setup-plan';

  interface Props {
    step?: SetupStep;
    onLogout?: () => void;
  }

  let { step = 'device', onLogout = () => {} }: Props = $props();

  const steps: SetupStep[] = [
    'device',
    'recovery',
    'profile',
    'notifications',
    'appearance',
    'layout',
    'sync',
    'consent',
    'done',
  ];
  const core = {
    ...useCoreClient(),
    session: { user_id: '@alex:sable.moe', device_id: 'STORYBOOK' },
    encryption: { verification: 'unverified', recovery: 'enabled', recovery_passphrase: false },
    deviceList: [{ is_own: false, cross_signed: true }],
  } as unknown as CoreClient;
  provideCoreClient(core);

  let reached = $state<number | null>(null);
  let viewing = $state<number | null>(null);
  const pendingIndex = $derived(reached ?? steps.indexOf(step));
  const activeIndex = $derived(viewing ?? pendingIndex);
  const profile = new ProfileController({
    core,
    getUserId: () => '@alex:sable.moe',
    onNavigateHome: () => {
      advance();
      return Promise.resolve();
    },
  });
  profile.displayName = 'Alex';

  function advance(): void {
    reached = Math.min(steps.length - 1, pendingIndex + 1);
    viewing = null;
  }
</script>

<div class="frame">
  <AuthPage hasLoggedInBefore title={i18n.t('setup.title')}>
    <SetupRail
      {steps}
      {activeIndex}
      {pendingIndex}
      canSkipAhead
      userId="@alex:sable.moe"
      {profile}
      askNotificationDefault
      {onLogout}
      onActivate={(index) => {
        if (index <= pendingIndex) viewing = index;
        else if (index === pendingIndex + 1) advance();
      }}
      onAdvance={advance}
    />
  </AuthPage>
</div>

<style>
  .frame {
    height: 100dvh;
  }
</style>
