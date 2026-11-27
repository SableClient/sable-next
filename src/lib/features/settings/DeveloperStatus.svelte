<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { debugLog } from '#lib/observability/debug-log.svelte.js';
  import { sanitizePayload } from '#lib/observability/scrubbers.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { Copied } from '#lib/ui/copied.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import CopyValue from '#lib/ui/primitives/CopyValue.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

  const core = useCoreClient();
  const roomList = useRoomList();
  const tokenCopied = new Copied();
  const reportCopied = new Copied();

  const KNOWN = [
    { flag: 'org.matrix.simplified_msc3575', label: 'settings.serverFeatureSlidingSync' },
    { flag: 'org.matrix.msc4140', label: 'settings.callCompatDelayed' },
    { flag: 'org.matrix.msc4354', label: 'settings.callCompatSticky' },
    { flag: 'computer.gingershaped.msc4466', label: 'settings.serverFeatureProfilePropagation' },
  ] as const;

  let features = $state.raw<string[] | null>(null);
  let featuresFailed = $state(false);
  let tokenFailed = $state(false);

  let syncState = $derived(core.sync?.state ?? 'offline');
  let syncLabel = $derived(
    syncState === 'live'
      ? i18n.t('settings.developerSyncLive')
      : syncState === 'syncing'
        ? i18n.t('settings.developerSyncSyncing')
        : syncState === 'error'
          ? i18n.t('settings.developerSyncError')
          : i18n.t('settings.developerSyncOffline')
  );
  let syncVariant: 'success' | 'critical' | 'warning' = $derived(
    syncState === 'live' ? 'success' : syncState === 'error' ? 'critical' : 'warning'
  );
  let errors = $derived(debugLog.entries.filter((entry) => entry.level === 'error').length);
  let warnings = $derived(debugLog.entries.filter((entry) => entry.level === 'warn').length);
  const sentryConfigured = Boolean(import.meta.env.VITE_SENTRY_DSN);

  $effect(() => {
    let stale = false;
    core.rpc.session
      .serverFeatures()
      .then((flags) => {
        if (!stale) features = flags;
      })
      .catch(() => {
        if (!stale) featuresFailed = true;
      });
    return () => {
      stale = true;
    };
  });

  function yesNo(value: boolean): string {
    return i18n.t(value ? 'settings.developerYes' : 'settings.developerNo');
  }

  async function copyToken(): Promise<void> {
    try {
      const token = await core.rpc.session.accessToken();
      if (!token) throw new Error('No access token');
      tokenFailed = !(await tokenCopied.copy(token, undefined, { toastOnError: false }));
    } catch {
      tokenFailed = true;
    }
  }

  function copyReport(): void {
    const report = {
      version: import.meta.env.VITE_APP_VERSION ?? 'dev',
      sync: {
        state: syncState,
        error: core.sync?.state === 'error' ? core.sync.message : null,
        core: core.status,
        crashed: core.crashed ?? null,
        unresponsive: core.unresponsive,
        rooms: roomList.rooms.length,
        account: core.session?.account_id ?? null,
        revision: core.accountRevision,
      },
      server_features: features,
      sentry: {
        configured: sentryConfigured,
        environment: import.meta.env.MODE,
        reporting: preferences.errorReporting,
        replay: preferences.sessionReplay,
        errors,
        warnings,
      },
    };
    void reportCopied.copy(JSON.stringify(sanitizePayload(report), null, 2));
  }
</script>

<div class="settings-form status">
  <div class="actions">
    <Button
      variant="secondary"
      size="small"
      id="access-token"
      disabled={!core.session}
      onclick={() => void copyToken()}
    >
      {i18n.t(tokenCopied.value ? 'common.copied' : 'settings.developerAccessTokenCopy')}
    </Button>
    <Button variant="secondary" size="small" onclick={copyReport}>
      {i18n.t(reportCopied.value ? 'common.copied' : 'settings.developerStatusCopy')}
    </Button>
  </div>
  <p class="hint">{i18n.t('settings.developerAccessTokenWarning')}</p>
  {#if tokenFailed}
    <Alert variant="critical">{i18n.t('settings.developerAccessTokenFailed')}</Alert>
  {/if}

  <table>
    <caption>{i18n.t('settings.developerSyncTitle')}</caption>
    <tbody>
      <tr id="sync-state">
        <th scope="row">{i18n.t('settings.developerSyncState')}</th>
        <td><StatusBadge label={syncLabel} variant={syncVariant} /></td>
      </tr>
      <tr id="sync-core-status">
        <th scope="row">{i18n.t('settings.developerSyncCoreStatus')}</th>
        <td><code>{core.status}</code></td>
      </tr>
      <tr id="sync-rooms">
        <th scope="row">{i18n.t('settings.developerSyncRooms')}</th>
        <td><code>{roomList.rooms.length}</code></td>
      </tr>
      <tr id="sync-revision">
        <th scope="row">{i18n.t('settings.developerSyncRevision')}</th>
        <td><code>{core.accountRevision}</code></td>
      </tr>
      <tr id="sync-unresponsive">
        <th scope="row">{i18n.t('settings.developerSyncUnresponsive')}</th>
        <td><code>{yesNo(core.unresponsive)}</code></td>
      </tr>
      <tr id="sync-account">
        <th scope="row">{i18n.t('settings.developerSyncAccount')}</th>
        <td>
          {#if core.session}<CopyValue value={core.session.account_id} />{:else}<code>-</code>{/if}
        </td>
      </tr>
    </tbody>
  </table>
  {#if core.sync?.state === 'error'}
    <p class="error">{core.sync.message}</p>
  {/if}
  {#if core.crashed}
    <p class="error">{core.crashed}</p>
  {/if}

  <table>
    <caption>{i18n.t('settings.developerServerFeaturesTitle')}</caption>
    <tbody>
      {#if featuresFailed}
        <tr><td colspan="2" class="error">{i18n.t('settings.callCompatFailed')}</td></tr>
      {:else if features}
        {#each KNOWN as known (known.flag)}
          {@const supported = features.includes(known.flag)}
          <tr id={`server-feature-${known.flag}`}>
            <th scope="row">{i18n.t(known.label)}</th>
            <td>
              <StatusBadge
                label={i18n.t(
                  supported ? 'settings.callCompatSupported' : 'settings.callCompatMissing'
                )}
                variant={supported ? 'success' : 'warning'}
              />
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
  {#if features && features.length > 0}
    <details>
      <summary>{i18n.t('settings.serverFeaturesAll', { count: features.length })}</summary>
      <ul class="flags">
        {#each features as flag (flag)}
          <li><CopyValue value={flag} /></li>
        {/each}
      </ul>
    </details>
  {/if}

  <table>
    <caption>{i18n.t('settings.developerSentryStatus')}</caption>
    <tbody>
      <tr id="sentry-configured">
        <th scope="row">{i18n.t('settings.developerSentryConfigured')}</th>
        <td>
          <StatusBadge
            label={i18n.t(
              sentryConfigured
                ? 'settings.developerSentryConfiguredYes'
                : 'settings.developerSentryConfiguredNo'
            )}
            variant={sentryConfigured ? 'success' : 'warning'}
          />
        </td>
      </tr>
      <tr id="sentry-environment">
        <th scope="row">{i18n.t('settings.developerSentryEnvironment')}</th>
        <td><code>{import.meta.env.MODE}</code></td>
      </tr>
      <tr id="sentry-reporting">
        <th scope="row">{i18n.t('settings.developerSentryReporting')}</th>
        <td><code>{yesNo(preferences.errorReporting)}</code></td>
      </tr>
      <tr id="sentry-replay">
        <th scope="row">{i18n.t('settings.developerSentryReplay')}</th>
        <td><code>{yesNo(preferences.sessionReplay)}</code></td>
      </tr>
      <tr id="sentry-activity">
        <th scope="row">{i18n.t('settings.developerSentryActivity')}</th>
        <td>
          <code>
            {errors}
            {i18n.t('settings.developerSentryErrors')}, {warnings}
            {i18n.t('settings.developerSentryWarnings')}
          </code>
        </td>
      </tr>
    </tbody>
  </table>
</div>

<style>
  .status {
    display: grid;
    gap: var(--space-300);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  caption {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding-block: var(--space-200);
    text-align: start;
  }

  th,
  td {
    border-top: var(--border-width) solid var(--surface-container-line);
    padding: var(--space-200) 0;
    vertical-align: middle;
  }

  th {
    color: var(--surface-var-on-container);
    font-weight: inherit;
    padding-inline-end: var(--space-400);
    text-align: start;
  }

  td {
    overflow-wrap: anywhere;
    text-align: end;
  }

  code {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    overflow-wrap: anywhere;
  }

  summary {
    cursor: pointer;
  }

  .flags {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: var(--space-200) 0 0;
    padding: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .error {
    color: var(--crit-main);
    margin: 0;
  }
</style>
