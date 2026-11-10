<script lang="ts">
  import type {
    DefaultNotificationModesView,
    EventNotificationsView,
    EventNotificationView,
    NotificationModeView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { type BadgeNotificationMode } from '#lib/settings/definitions.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';

  import { notificationModeLabels } from '#lib/rooms/notification-modes.js';

  import { settingsChanges } from './notifications.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const modes: Exclude<NotificationModeView, 'mute'>[] = ['all', 'mentions'];
  const badgeModes: BadgeNotificationMode[] = ['all', 'mentions', 'quiet'];
  const badgeModeLabels: Record<BadgeNotificationMode, string> = {
    all: notificationModeLabels.all,
    mentions: notificationModeLabels.mentions,
    quiet: 'room.notifyMentionsQuiet',
  };

  const badgeRows: {
    key: 'badgeDefaultDirect' | 'badgeDefaultGroup';
    label: string;
  }[] = [
    { key: 'badgeDefaultDirect', label: 'common.directMessages' },
    { key: 'badgeDefaultGroup', label: 'settings.notificationDefaultGroup' },
  ];

  const pushRows: {
    key: keyof DefaultNotificationModesView;
    label: string;
    direct: boolean;
  }[] = [
    { key: 'direct', label: 'settings.notificationDefaultDirectRooms', direct: true },
    { key: 'group', label: 'settings.notificationDefaultOtherRooms', direct: false },
  ];

  const eventRows: { key: EventNotificationView; label: string }[] = [
    { key: 'membership', label: 'settings.notificationMembership' },
    { key: 'reactions', label: 'settings.notificationReactions' },
    { key: 'edits', label: 'settings.notificationEdits' },
    { key: 'notices', label: 'settings.notificationNotices' },
    { key: 'invites', label: 'settings.notificationInvites' },
    { key: 'rtc_user', label: 'settings.notificationCalls' },
    { key: 'rtc_room', label: 'settings.notificationRoomCalls' },
    { key: 'calls', label: 'settings.notificationLegacyCalls' },
  ];

  const eventItems = [
    { value: 'on', label: 'settings.mentionsNotify' },
    { value: 'off', label: 'settings.mentionsOff' },
  ];

  let current = $state<DefaultNotificationModesView | null>(null);
  let events = $state<EventNotificationsView | null>(null);
  let muted = $state<boolean | null>(null);
  let failed = $state(false);
  $effect(() => {
    void settingsChanges.version;

    let alive = true;
    void core.rpc.notifications
      .defaultModes()
      .then((modes) => {
        if (!alive) return;
        current = modes;
        failed = false;
      })
      .catch((error: unknown) => {
        console.warn('[sable notifications] loading default modes failed', error);
        if (alive) failed = true;
      });
    void core.rpc.notifications.eventNotifications().then(
      (view) => {
        if (alive) events = view;
      },
      (error: unknown) => {
        console.warn('[sable notifications] loading event settings failed', error);
        if (alive) failed = true;
      }
    );
    void core.rpc.notifications.masterMute().then(
      (value) => {
        if (alive) muted = value;
      },
      (error: unknown) => console.warn('[sable notifications] loading master mute failed', error)
    );

    return () => {
      alive = false;
    };
  });

  function savePush(
    key: keyof DefaultNotificationModesView,
    isDirect: boolean,
    mode: NotificationModeView
  ): void {
    if (current) current = { ...current, [key]: mode };

    void core.rpc.notifications.setDefaultMode({ direct: isDirect, mode }).then(
      () => {
        settingsChanges.version += 1;
      },
      (error: unknown) => {
        console.warn('[sable notifications] saving default mode failed', error);
        failed = true;
        settingsChanges.version += 1;
      }
    );
  }

  function saveMute(value: boolean): void {
    muted = value;

    void core.rpc.notifications.setMasterMute({ muted: value }).catch((error: unknown) => {
      console.warn('[sable notifications] saving master mute failed', error);
      failed = true;
      settingsChanges.version += 1;
    });
  }

  function saveEvent(event: EventNotificationView, enabled: boolean): void {
    if (events) events = { ...events, [event]: enabled };

    void core.rpc.notifications.setEventNotification({ event, enabled }).catch((error: unknown) => {
      console.warn('[sable notifications] saving event setting failed', error);
      failed = true;
      settingsChanges.version += 1;
    });
  }
</script>

<section class="defaults settings-form" aria-labelledby="notification-badges">
  <div class="settings-heading-row">
    <h3 id="notification-badges" data-settings-outline>
      {i18n.t('settings.notificationBadges')}
    </h3>
    <SettingsAnchorLink anchor="notification-badges" />
  </div>
  <p class="hint settings-description">{i18n.t('settings.notificationBadgesHint')}</p>

  <ul class="settings-rows">
    {#each badgeRows as { key, label } (key)}
      <SettingsRow id={`notification-badge-${key}`} title={i18n.t(label)} {key}>
        <Select
          aria-label={`${i18n.t('settings.notificationBadges')}: ${i18n.t(label)}`}
          value={preferences[key]}
          items={badgeModes.map((mode) => ({ value: mode, label: i18n.t(badgeModeLabels[mode]) }))}
          onValueChange={(value) => {
            setPreference(key, value as BadgeNotificationMode);
          }}
        />
      </SettingsRow>
    {/each}
  </ul>
</section>

<section class="defaults settings-form" aria-labelledby="notification-push">
  <div class="settings-heading-row">
    <h3 id="notification-push" data-settings-outline>
      {i18n.t('settings.notificationPush')}
    </h3>
    <SettingsAnchorLink anchor="notification-push" />
  </div>
  <p class="hint settings-description">{i18n.t('settings.notificationPushHint')}</p>
  <p class="hint settings-description">{i18n.t('settings.notificationMemberCountHint')}</p>
  <p class="hint settings-description">{i18n.t('settings.notificationRulesCleanupHint')}</p>

  {#if failed}
    <Alert variant="warning" role="status">
      <p>{i18n.t('settings.notificationDefaultsFailed')}</p>
    </Alert>
  {/if}

  <ul class="settings-rows">
    {#if muted !== null}
      <SettingsRow
        id="notification-master-mute"
        title={i18n.t('settings.notificationMasterMute')}
        description={i18n.t('settings.notificationMasterMuteHint')}
      >
        <Switch
          label={i18n.t('settings.notificationMasterMute')}
          checked={muted}
          onCheckedChange={saveMute}
        />
      </SettingsRow>
    {/if}
    {#each pushRows as { key, label, direct } (key)}
      <SettingsRow id={`notification-push-${key}`} title={i18n.t(label)}>
        {#if current}
          <Select
            aria-label={`${i18n.t('settings.notificationPush')}: ${i18n.t(label)}`}
            value={current[key]}
            items={modes.map((mode) => ({
              value: mode,
              label: i18n.t(notificationModeLabels[mode]),
            }))}
            onValueChange={(value) => {
              savePush(key, direct, value as NotificationModeView);
            }}
          />
        {/if}
      </SettingsRow>
    {/each}
    {#if events}
      {#each eventRows as { key, label } (key)}
        {@const supported = events[key] != null}
        {#if supported || key === 'rtc_user' || key === 'rtc_room'}
          <SettingsRow
            id={`notification-event-${key}`}
            title={i18n.t(label)}
            description={!supported ? i18n.t('settings.notificationRtcUnavailableHint') : undefined}
          >
            {#if supported}
              <Select
                aria-label={i18n.t(label)}
                value={events[key] ? 'on' : 'off'}
                items={eventItems.map((item) => ({ value: item.value, label: i18n.t(item.label) }))}
                onValueChange={(value) => {
                  saveEvent(key, value === 'on');
                }}
              />
            {:else}
              <span class="hint">{i18n.t('settings.unavailable')}</span>
            {/if}
          </SettingsRow>
        {/if}
      {/each}
    {/if}
  </ul>
</section>
