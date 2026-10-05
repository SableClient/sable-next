<script lang="ts">
  import type {
    DefaultNotificationModesView,
    EventNotificationsView,
    EventNotificationView,
    NotificationModeView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    type BadgeNotificationMode,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';

  import { settingsChanges } from './notifications.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const modeLabels: Record<Exclude<NotificationModeView, 'mute'>, string> = {
    all: 'room.notifyAll',
    mentions: 'room.notifyMentions',
  };

  const modes: Exclude<NotificationModeView, 'mute'>[] = ['all', 'mentions'];
  const badgeModes: BadgeNotificationMode[] = ['all', 'mentions', 'quiet'];
  const badgeModeLabels: Record<BadgeNotificationMode, string> = {
    ...modeLabels,
    quiet: 'room.notifyMentionsQuiet',
  };

  const badgeRows: {
    key: 'badgeDefaultDirect' | 'badgeDefaultGroup';
    label: string;
  }[] = [
    { key: 'badgeDefaultDirect', label: 'settings.notificationDefaultDirect' },
    { key: 'badgeDefaultGroup', label: 'settings.notificationDefaultGroup' },
  ];

  const pushRows: {
    key: keyof DefaultNotificationModesView;
    label: string;
    direct: boolean;
  }[] = [
    { key: 'direct', label: 'settings.notificationDefaultDirect', direct: true },
    { key: 'group', label: 'settings.notificationDefaultGroup', direct: false },
  ];

  const eventRows: { key: EventNotificationView; label: string }[] = [
    { key: 'membership', label: 'settings.notificationMembership' },
    { key: 'reactions', label: 'settings.notificationReactions' },
    { key: 'edits', label: 'settings.notificationEdits' },
    { key: 'notices', label: 'settings.notificationNotices' },
    { key: 'invites', label: 'settings.notificationInvites' },
    { key: 'calls', label: 'settings.notificationCalls' },
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
    void core.commands
      .defaultNotificationModes()
      .then((modes) => {
        if (!alive) return;
        current = modes;
        failed = false;
      })
      .catch(() => {
        if (alive) failed = true;
      });
    void core.commands.eventNotifications().then(
      (view) => {
        if (alive) events = view;
      },
      () => undefined
    );
    void core.commands.masterMute().then(
      (value) => {
        if (alive) muted = value;
      },
      () => undefined
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

    void core.commands.setDefaultNotificationMode(isDirect, mode).then(
      () => {
        settingsChanges.version += 1;
      },
      () => {
        failed = true;
        settingsChanges.version += 1;
      }
    );
  }

  function saveMute(value: boolean): void {
    muted = value;

    void core.commands.setMasterMute(value).catch(() => {
      failed = true;
      settingsChanges.version += 1;
    });
  }

  function saveEvent(event: EventNotificationView, enabled: boolean): void {
    if (events) events = { ...events, [event]: enabled };

    void core.commands.setEventNotification(event, enabled).catch(() => {
      failed = true;
      settingsChanges.version += 1;
    });
  }
</script>

<section class="defaults settings-form" aria-labelledby="notification-badges">
  <div class="settings-heading-row">
    <h3 id="notification-badges" data-settings-outline>
      {$i18n.t('settings.notificationBadges')}
    </h3>
    <SettingsAnchorLink anchor="notification-badges" />
  </div>
  <p class="hint settings-description">{$i18n.t('settings.notificationBadgesHint')}</p>

  <ul class="settings-rows">
    {#each badgeRows as { key, label } (key)}
      <SettingsRow title={$i18n.t(label)}>
        <Select
          aria-label={`${$i18n.t('settings.notificationBadges')}: ${$i18n.t(label)}`}
          value={preferences[key]}
          items={badgeModes.map((mode) => ({ value: mode, label: $i18n.t(badgeModeLabels[mode]) }))}
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
      {$i18n.t('settings.notificationPush')}
    </h3>
    <SettingsAnchorLink anchor="notification-push" />
  </div>
  <p class="hint settings-description">{$i18n.t('settings.notificationPushHint')}</p>

  {#if failed}
    <Alert variant="warning" role="status">
      <p>{$i18n.t('settings.notificationDefaultsFailed')}</p>
    </Alert>
  {/if}

  <ul class="settings-rows">
    {#if muted !== null}
      <SettingsRow
        title={$i18n.t('settings.notificationMasterMute')}
        description={$i18n.t('settings.notificationMasterMuteHint')}
      >
        <Switch
          label={$i18n.t('settings.notificationMasterMute')}
          checked={muted}
          onCheckedChange={saveMute}
        />
      </SettingsRow>
    {/if}
    {#each pushRows as { key, label, direct } (key)}
      <SettingsRow title={$i18n.t(label)}>
        {#if current}
          <Select
            aria-label={`${$i18n.t('settings.notificationPush')}: ${$i18n.t(label)}`}
            value={current[key]}
            items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
            onValueChange={(value) => {
              savePush(key, direct, value as NotificationModeView);
            }}
          />
        {/if}
      </SettingsRow>
    {/each}
    {#if events}
      {#each eventRows as { key, label } (key)}
        {#if events[key] !== null}
          <SettingsRow title={$i18n.t(label)}>
            <Select
              aria-label={$i18n.t(label)}
              value={events[key] ? 'on' : 'off'}
              items={eventItems.map((item) => ({ value: item.value, label: $i18n.t(item.label) }))}
              onValueChange={(value) => {
                saveEvent(key, value === 'on');
              }}
            />
          </SettingsRow>
        {/if}
      {/each}
    {/if}
  </ul>
</section>
