<script lang="ts">
  import BellRingingIcon from 'phosphor-svelte/lib/BellRingingIcon';
  import BellSimpleIcon from 'phosphor-svelte/lib/BellSimpleIcon';

  import type { NotificationModeView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { grantPermission, permissionState } from '#lib/features/notifications/present.js';
  import { i18n, t } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  type GroupMode = Extract<NotificationModeView, 'all' | 'mentions'>;

  interface Props {
    askDefault: boolean;
    onComplete: () => void;
    saving?: boolean;
  }

  let { askDefault, onComplete, saving = $bindable(false) }: Props = $props();
  const core = useCoreClient();
  let permission = $state<Awaited<ReturnType<typeof permissionState>> | null>(null);
  let groupMode = $state<GroupMode>('all');
  let groupModeChanged = false;
  let error = $state<string | null>(null);
  const contentId = $props.id();

  $effect(() => {
    let alive = true;
    void permissionState().then((state) => {
      if (alive) permission = state;
    });
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    if (!askDefault) return;
    let alive = true;
    void core.rpc.notifications.defaultModes().then(
      ({ group }) => {
        if (alive && !groupModeChanged) groupMode = group === 'all' ? 'all' : 'mentions';
      },
      (error: unknown) => {
        console.debug('[sable setup] default notification modes unavailable', error);
      }
    );
    return () => {
      alive = false;
    };
  });

  function allow(): void {
    error = null;
    void grantPermission().then((granted) => {
      if (granted) setPreference('systemNotifications', true);
      permission = granted ? 'granted' : 'denied';
    });
  }

  async function finish(): Promise<void> {
    if (!askDefault) {
      onComplete();
      return;
    }
    saving = true;
    error = null;
    try {
      await core.rpc.notifications.setDefaultMode({ direct: false, mode: groupMode });
      onComplete();
    } catch {
      error = t('setup.notificationsSaveFailed');
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="notifications-setup-card auth-card-surface"
  aria-labelledby="notifications-setup-title"
  onsubmit={(event) => {
    event.preventDefault();
    void finish();
  }}
>
  <AuthField labelId="notifications-setup-title" label={i18n.t('setup.notificationsTitle')}>
    <AuthInfoBox>
      {#if permission === 'granted'}
        {i18n.t('setup.notificationsAllowed')}
      {:else if permission === 'denied'}
        {i18n.t('setup.notificationsBlocked')}
      {:else if permission === 'unsupported'}
        {i18n.t('setup.notificationsUnsupported')}
      {:else}
        {i18n.t('setup.notificationsDescription')}
      {/if}
    </AuthInfoBox>
  </AuthField>

  {#if permission === 'prompt'}
    <Button onclick={allow}>
      <BellRingingIcon aria-hidden="true" />
      {i18n.t('common.allowNotifications')}
    </Button>
  {/if}

  {#if permission === 'granted'}
    <ul class="settings-rows">
      <SettingsRow
        id="notification-content"
        key="notificationContent"
        title={i18n.t('settings.notificationContent')}
        description={i18n.t('settings.notificationContentHint')}
        control={contentId}
      >
        <Switch
          id={contentId}
          checked={preferences.notificationContent}
          label={i18n.t('settings.notificationContent')}
          onCheckedChange={(checked) => {
            setPreference('notificationContent', checked);
          }}
        />
      </SettingsRow>
    </ul>
  {/if}

  {#if askDefault}
    <AuthField labelId="notifications-group-title" label={i18n.t('setup.notificationsGroupLabel')}>
      <OptionCards
        label={i18n.t('setup.notificationsGroupLabel')}
        value={groupMode}
        disabled={saving}
        options={[
          {
            value: 'all',
            label: i18n.t('room.notifyAll'),
            hint: i18n.t('setup.notificationsAllHint'),
            icon: BellRingingIcon,
          },
          {
            value: 'mentions',
            label: i18n.t('room.notifyMentions'),
            hint: i18n.t('setup.notificationsMentionsHint'),
            icon: BellSimpleIcon,
          },
        ]}
        onSelect={(mode) => {
          groupModeChanged = true;
          groupMode = mode;
        }}
      />
    </AuthField>
  {/if}

  <AuthStatusSlot message={error} />

  <Button type="submit" variant="primary" block loading={saving}>
    {i18n.t('auth.continue')}
  </Button>
</form>

<style>
  .notifications-setup-card {
    min-width: 0;
  }

  .notifications-setup-card :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }
</style>
