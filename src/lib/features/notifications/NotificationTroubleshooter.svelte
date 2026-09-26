<script lang="ts">
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
  import MinusCircleIcon from 'phosphor-svelte/lib/MinusCircleIcon';
  import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
  import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { nativeDevicePusher, nativePushTransport } from '#lib/platform/native-notifications.js';
  import { deliversWebPush, pushPlatform } from '#lib/platform/notifications.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import '#lib/ui/primitives/settings-row.css';

  import { grantPermission, permissionGranted } from './present';
  import { loadPushHistory } from './push-history-source';
  import {
    type TroubleshootCheck,
    type TroubleshootDeps,
    type TroubleshootResult,
    troubleshoot,
  } from './push-troubleshoot';
  import { currentPushKey } from './web-push';

  const core = useCoreClient();

  const checks: { check: TroubleshootCheck; label: string }[] = [
    { check: 'permission', label: 'settings.troubleshootCheckPermission' },
    { check: 'alerts', label: 'settings.troubleshootCheckAlerts' },
    { check: 'transport', label: 'settings.troubleshootCheckTransport' },
    { check: 'pusher', label: 'settings.troubleshootCheckPusher' },
    { check: 'gateway', label: 'settings.troubleshootCheckGateway' },
    { check: 'loopback', label: 'settings.troubleshootCheckLoopback' },
  ];

  let results = $state.raw<Partial<Record<TroubleshootCheck, TroubleshootResult>>>({});
  let running = $state(false);
  let started = $state(false);

  function deps(): TroubleshootDeps {
    const platform = pushPlatform();
    return {
      platform,
      webPushSupported: deliversWebPush(),
      permissionGranted,
      alertsEnabled: () => preferences.systemNotifications,
      nativeTransport: nativePushTransport,
      ownPushkey: async () => {
        if (platform === 'web') return currentPushKey();
        const session = core.session;
        if (!session) return null;
        return (await nativeDevicePusher(session.user_id, session.device_id))?.pushkey ?? null;
      },
      pushers: () => core.commands.webPushers(),
      pingGateway: (url) => core.commands.pingPushGateway(url),
      sendDiagnostic: (pushkey, appId) => core.commands.sendDiagnosticPush(pushkey, appId),
      history: loadPushHistory,
      wait: (ms) =>
        new Promise((settle) => {
          setTimeout(settle, ms);
        }),
    };
  }

  async function run(): Promise<void> {
    running = true;
    started = true;
    results = {};
    try {
      for await (const result of troubleshoot(deps())) {
        results = { ...results, [result.check]: result };
      }
    } finally {
      running = false;
    }
  }

  async function allow(): Promise<void> {
    await grantPermission();
    await run();
  }

  async function enableAlerts(): Promise<void> {
    setPreference('systemNotifications', true);
    await run();
  }
</script>

<section class="troubleshoot settings-form" aria-labelledby="notification-troubleshoot">
  <div class="settings-heading-row">
    <h3 id="notification-troubleshoot" data-settings-outline>
      {$i18n.t('settings.troubleshootTitle')}
    </h3>
    <SettingsAnchorLink anchor="notification-troubleshoot" />
  </div>
  <p class="hint">{$i18n.t('settings.troubleshootHint')}</p>

  {#if started}
    <ol class="checks">
      {#each checks as { check, label } (check)}
        {@const result = results[check]}
        <li class={['check', result?.state]}>
          <span class="state" aria-hidden="true">
            {#if result === undefined}
              {#if running}<Spinner small />{:else}<MinusCircleIcon />{/if}
            {:else if result.state === 'pass'}
              <CheckCircleIcon weight="fill" />
            {:else if result.state === 'fail'}
              <XCircleIcon weight="fill" />
            {:else if result.state === 'warn'}
              <WarningCircleIcon weight="fill" />
            {:else}
              <MinusCircleIcon />
            {/if}
          </span>
          <span class="copy">
            <span class="label">{$i18n.t(label)}</span>
            {#if result}
              <span class="message">{$i18n.t(result.message, result.params ?? {})}</span>
            {/if}
          </span>
          {#if result?.state === 'fail' && check === 'permission'}
            <Button
              variant="secondary"
              size="small"
              disabled={running}
              onclick={() => void allow()}
            >
              {$i18n.t('settings.troubleshootAllow')}
            </Button>
          {:else if result?.state === 'fail' && check === 'alerts'}
            <Button
              variant="secondary"
              size="small"
              disabled={running}
              onclick={() => void enableAlerts()}
            >
              {$i18n.t('settings.troubleshootEnable')}
            </Button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <div>
    <Button variant="secondary" size="small" disabled={running} onclick={() => void run()}>
      {$i18n.t(started ? 'settings.troubleshootRunAgain' : 'settings.troubleshootRun')}
    </Button>
  </div>
</section>

<style>
  .troubleshoot {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
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

  .checks {
    display: grid;
    gap: var(--space-300);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .check {
    align-items: start;
    display: grid;
    gap: var(--space-200);
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .state {
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--icon-size-small);
  }

  .check.pass .state {
    color: var(--success-main);
  }

  .check.fail .state {
    color: var(--crit-main);
  }

  .check.warn .state {
    color: var(--warn-main);
  }

  .copy {
    display: grid;
    gap: var(--space-050);
  }

  .label {
    font-weight: var(--font-weight-medium);
  }

  .message {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }
</style>
