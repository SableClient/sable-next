<script lang="ts">
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import type {
    MentionNotificationModeView,
    MentionNotificationsView,
    MentionRuleView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';

  import { settingsChanges } from './notifications.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();

  const modes: MentionNotificationModeView[] = ['off', 'notify', 'loud'];
  const modeLabels: Record<MentionNotificationModeView, string> = {
    off: 'settings.mentionsOff',
    notify: 'settings.mentionsNotify',
    loud: 'settings.mentionsLoud',
  };
  let current = $state<MentionNotificationsView | null>(null);
  let failed = $state(false);
  let displayName = $state('');

  let userId = $derived(core.session?.user_id ?? '');
  let username = $derived(userId.replace(/^@/, '').split(':')[0] ?? '');
  let rules = $derived<
    { rule: MentionRuleView; key: keyof MentionNotificationsView; label: string; hint?: string }[]
  >([
    { rule: 'user', key: 'user', label: $i18n.t('settings.mentionsUser', { userId }) },
    {
      rule: 'display_name',
      key: 'display_name',
      label: $i18n.t('settings.mentionsDisplayName', { displayName }),
    },
    {
      rule: 'username',
      key: 'username',
      label: $i18n.t('settings.mentionsUsername', { username }),
    },
    {
      rule: 'room',
      key: 'room',
      label: $i18n.t('settings.mentionsRoom'),
      hint: $i18n.t('settings.mentionsRoomHint'),
    },
  ]);
  let shown = $derived(rules.filter(({ key }) => current?.[key] !== null));

  $effect(() => {
    if (!userId) return;

    let alive = true;
    void core.userProfile(userId).then(
      (profile) => {
        if (alive) displayName = profile.display_name ?? '';
      },
      () => undefined
    );

    return () => {
      alive = false;
    };
  });

  $effect(() => {
    void settingsChanges.version;

    let alive = true;
    void core.commands
      .mentionNotifications()
      .then((modes) => {
        if (!alive) return;
        current = modes;
        failed = false;
      })
      .catch(() => {
        if (alive) failed = true;
      });

    return () => {
      alive = false;
    };
  });

  function save(
    rule: MentionRuleView,
    key: keyof MentionNotificationsView,
    mode: MentionNotificationModeView
  ): void {
    if (current) current = { ...current, [key]: mode };

    void core.commands.setMentionNotifications(rule, mode).catch(() => {
      failed = true;
      settingsChanges.version += 1;
    });
  }
</script>

<section class="mentions settings-form" aria-labelledby="mention-notifications">
  <div class="settings-heading-row">
    <h3 id="mention-notifications" data-settings-outline>{$i18n.t('settings.mentions')}</h3>
    <SettingsAnchorLink anchor="mention-notifications" />
  </div>
  <p class="hint settings-description">{$i18n.t('settings.mentionsHint')}</p>

  {#if failed}
    <Alert variant="warning" role="status">
      <p>{$i18n.t('settings.mentionsFailed')}</p>
    </Alert>
  {/if}

  <ul class="settings-rows">
    {#each shown as { rule, key, label, hint } (rule)}
      <SettingsRow title={label} description={hint}>
        {#if current}
          <Select
            aria-label={label}
            value={current[key] ?? undefined}
            items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
            onValueChange={(value) => {
              save(rule, key, value as MentionNotificationModeView);
            }}
          />
        {/if}
      </SettingsRow>
    {/each}
  </ul>
</section>
