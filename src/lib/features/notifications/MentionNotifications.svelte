<script lang="ts">
  import type {
    MentionNotificationModeView,
    MentionNotificationsView,
    MentionRuleView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';

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
    });
  }
</script>

<section class="mentions" aria-labelledby="mention-notifications">
  <h3 id="mention-notifications">{$i18n.t('settings.mentions')}</h3>
  <p class="hint">{$i18n.t('settings.mentionsHint')}</p>

  {#if failed}
    <Alert variant="warning" role="status">
      <p>{$i18n.t('settings.mentionsFailed')}</p>
    </Alert>
  {/if}

  <div class="rows">
    {#each rules as { rule, key, label, hint } (rule)}
      <label>
        <span>
          {label}
          {#if hint}<small>{hint}</small>{/if}
        </span>
        {#if current}
          <Select
            aria-label={label}
            value={current[key]}
            items={modes.map((mode) => ({ value: mode, label: $i18n.t(modeLabels[mode]) }))}
            onValueChange={(value) => {
              save(rule, key, value as MentionNotificationModeView);
            }}
          />
        {/if}
      </label>
    {/each}
  </div>
</section>

<style>
  .mentions {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rows {
    display: grid;
    gap: var(--space-300);
  }

  small {
    color: var(--surface-var-on-container);
    display: block;
    font-size: var(--font-size-small);
  }

  label {
    align-items: stretch;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    justify-content: space-between;
  }

  @media (width >= 32rem) {
    label {
      align-items: center;
      display: grid;
      gap: var(--space-400);
      grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    }
  }
</style>
