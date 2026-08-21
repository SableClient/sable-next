<script lang="ts">
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
  import DesktopTowerIcon from 'phosphor-svelte/lib/DesktopTowerIcon';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';
  import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
  import { invoke, isTauri } from '@tauri-apps/api/core';

  import type { DeviceView } from '#src/generated/DeviceView';
  import type { EncryptionStatusView } from '#src/generated/EncryptionStatusView';
  import { CoreError } from '#src/transport';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import VerifyDeviceDialog from './VerifyDeviceDialog.svelte';
  import DeviceActionForm from './DeviceActionForm.svelte';

  const core = useCoreClient();
  let devices = $state<DeviceView[]>([]);
  let accountManagement = $state(false);
  let status = $state<EncryptionStatusView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let displayName = $state('');
  let password = $state('');
  let managingRecovery = $state(false);
  let newRecoveryKey = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let verificationOpen = $state(false);
  let currentDevice = $derived(devices.find((device) => device.is_own));
  let cancelled = false;

  function deviceName(device: DeviceView | undefined): string {
    return device?.display_name?.trim() || t('settings.unnamedDevice');
  }

  const verificationLabel = (value: EncryptionStatusView['verification']) =>
    value === 'verified'
      ? t('settings.verified')
      : value === 'unverified'
        ? t('settings.notVerified')
        : t('settings.unavailable');
  function messageFor(error: unknown): string {
    if (!(error instanceof CoreError)) return t('settings.actionFailed');
    if (error.detail.code === 'interactive_auth_required') return t('settings.enterPassword');
    if (error.detail.code === 'denied') return t('settings.wrongPassword');
    if (error.detail.code === 'unavailable') return t('settings.verificationUnavailable');
    return t('settings.actionFailed');
  }

  function recoveryMessageFor(error: unknown): string {
    if (error instanceof CoreError && error.detail.code === 'denied') {
      return t('settings.invalidRecoveryKey');
    }
    return messageFor(error);
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        core.encryptionStatus(),
        core.devices(),
      ]);
      if (cancelled) return;
      status = nextStatus;
      devices = nextDevices.devices;
      accountManagement = nextDevices.accountManagement;
    } catch (cause) {
      if (!cancelled) error = messageFor(cause);
    } finally {
      if (!cancelled) loading = false;
    }
  }

  function beginRename(device: DeviceView): void {
    editing = device.device_id;
    displayName = device.display_name ?? '';
  }

  function cancelRename(): void {
    editing = null;
    displayName = '';
  }

  function cancelRemoval(): void {
    deleting = null;
    password = '';
  }

  async function saveName(deviceId: string): Promise<void> {
    try {
      await core.renameDevice(deviceId, displayName.trim());
      cancelRename();
      await refresh();
    } catch (cause) {
      error = recoveryMessageFor(cause);
    }
  }

  async function removeDevice(deviceId: string, popup: Window | null = null): Promise<void> {
    try {
      const managementUrl = await core.deleteDevice(deviceId, password || null);
      cancelRemoval();
      if (managementUrl) {
        if (isTauri()) await invoke('open_auth_url', { url: managementUrl });
        else if (popup) popup.location.replace(managementUrl);
        else window.open(managementUrl, '_blank', 'noopener');
      } else {
        await refresh();
      }
    } catch (cause) {
      popup?.close();
      error = messageFor(cause);
    }
  }

  function beginRemoval(deviceId: string): void {
    if (!accountManagement) {
      deleting = deviceId;
      return;
    }

    const popup = isTauri()
      ? null
      : window.open(
          'about:blank',
          `sable-device-${crypto.randomUUID()}`,
          'popup,width=520,height=720'
        );
    if (!isTauri() && !popup) {
      error = t('settings.actionFailed');
      return;
    }
    void removeDevice(deviceId, popup);
  }

  async function manageRecovery(reset = false): Promise<void> {
    managingRecovery = true;
    error = null;
    try {
      newRecoveryKey = reset ? await core.resetRecoveryKey() : await core.enableRecovery();
      await refresh();
    } catch (cause) {
      error = messageFor(cause);
    } finally {
      managingRecovery = false;
    }
  }

  $effect(() => {
    void refresh();
    const unsubscribe = core.subscribeEvents((event) => {
      if (event.type === 'encryption_status') status = event.status;
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  });
</script>

{#snippet refreshAction()}
  <IconButton
    variant="ghost"
    size="small"
    label={$i18n.t('settings.refresh')}
    onclick={refresh}
    disabled={loading}
  >
    <ArrowClockwiseIcon />
  </IconButton>
{/snippet}

<AppPageShell
  title={$i18n.t('settings.devicesTitle')}
  density="compact"
  class="devices-settings"
  actions={refreshAction}
>
  {#if error}<Alert class="settings-error" variant="critical" role="alert">{error}</Alert>{/if}

  {#if newRecoveryKey}
    <Alert class="recovery-key" variant="warning" role="status">
      <div class="recovery-key-heading">
        <KeyIcon aria-hidden="true" />
        <div>
          <strong>{$i18n.t('settings.saveRecoveryKey')}</strong>
          <p>{$i18n.t('settings.saveRecoveryKeyDescription')}</p>
        </div>
      </div>
      <code>{newRecoveryKey}</code>
      <Button onclick={() => (newRecoveryKey = null)}>{$i18n.t('settings.savedRecoveryKey')}</Button
      >
    </Alert>
  {/if}

  <div class="settings-stack" aria-busy={loading}>
    <SettingsSection headingId="encryption-heading" title={$i18n.t('settings.encryption')}>
      {#if status}
        <dl class="status-grid">
          <div class="status-item">
            <span
              class="status-icon"
              class:positive={status.verification === 'verified'}
              aria-hidden="true"
            >
              {#if status.verification === 'verified'}<CheckCircleIcon
                  weight="fill"
                />{:else}<WarningCircleIcon />{/if}
            </span>
            <div class="status-copy">
              <dt class="device-name">{deviceName(currentDevice)}</dt>
              <dd>
                <StatusBadge
                  variant={status.verification === 'verified'
                    ? 'success'
                    : status.verification === 'unverified'
                      ? 'warning'
                      : 'neutral'}
                  label={verificationLabel(status.verification)}
                />
              </dd>
            </div>
            {#if status.verification !== 'verified'}
              <Button variant="primary" onclick={() => (verificationOpen = true)}>
                {$i18n.t('settings.verifyDevice')}
              </Button>
            {/if}
          </div>
        </dl>

        {#if status.verification === 'verified'}
          <div class="setting-row">
            <span class="row-icon" aria-hidden="true"><KeyIcon /></span>
            <div class="row-copy">
              <strong
                >{$i18n.t(
                  status.recovery === 'enabled'
                    ? 'settings.resetRecoveryKey'
                    : 'settings.setUpRecovery'
                )}</strong
              >
              <p>
                {$i18n.t(
                  status.recovery === 'enabled'
                    ? 'settings.resetRecoveryKeyDescription'
                    : 'settings.setUpRecoveryDescription'
                )}
              </p>
            </div>
            <Button
              variant={status.recovery === 'enabled' ? 'secondary' : 'primary'}
              loading={managingRecovery}
              onclick={() => void manageRecovery(status?.recovery === 'enabled')}
            >
              {$i18n.t(
                status.recovery === 'enabled'
                  ? 'settings.resetRecoveryKey'
                  : 'settings.setUpRecovery'
              )}
            </Button>
          </div>
        {/if}
      {:else if loading}
        <div class="loading-state">
          <Spinner /><span>{$i18n.t('settings.loadingEncryption')}</span>
        </div>
      {/if}
    </SettingsSection>

    <SettingsSection headingId="devices-heading" title={$i18n.t('settings.signedInDevices')}>
      {#if loading}
        <div class="loading-state">
          <Spinner /><span>{$i18n.t('settings.loadingDevices')}</span>
        </div>
      {:else if devices.length === 0}
        <div class="empty-state">
          <DesktopTowerIcon />
          <p>{$i18n.t('settings.noDevices')}</p>
        </div>
      {:else}
        <ul class="device-list">
          {#each devices as device (device.device_id)}
            <li class="device">
              <div class="device-summary">
                <span class="device-icon" aria-hidden="true"><DesktopTowerIcon /></span>
                <div class="device-info">
                  <div class="device-name-line">
                    <span class="device-name">{deviceName(device)}</span>
                    {#if device.is_own}<StatusBadge
                        variant="primary"
                        label={$i18n.t('settings.currentDevice')}
                      />{/if}
                  </div>
                  <div class="device-meta">
                    <StatusBadge
                      variant={device.is_verified ? 'success' : 'warning'}
                      label={device.is_verified
                        ? $i18n.t('settings.verified')
                        : $i18n.t('settings.notVerified')}
                    />
                    <code title={device.device_id}>{device.device_id}</code>
                  </div>
                </div>
                {#if !device.is_own && editing !== device.device_id && deleting !== device.device_id}
                  <div class="device-actions">
                    <Button
                      variant="ghost"
                      size="small"
                      onclick={() => {
                        beginRename(device);
                      }}
                    >
                      {$i18n.t('settings.rename')}
                    </Button>
                    <Button
                      variant="danger"
                      size="small"
                      onclick={() => {
                        beginRemoval(device.device_id);
                      }}
                    >
                      {$i18n.t('settings.remove')}
                    </Button>
                  </div>
                {/if}
              </div>

              {#if editing === device.device_id}
                <DeviceActionForm
                  mode="rename"
                  deviceId={device.device_id}
                  bind:displayName
                  onSubmit={() => void saveName(device.device_id)}
                  onCancel={cancelRename}
                />
              {/if}

              {#if deleting === device.device_id}
                <DeviceActionForm
                  mode="remove"
                  deviceId={device.device_id}
                  {accountManagement}
                  bind:password
                  onSubmit={() => void removeDevice(device.device_id)}
                  onCancel={cancelRemoval}
                />
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </SettingsSection>
  </div>
</AppPageShell>

{#if status}
  <VerifyDeviceDialog
    bind:open={verificationOpen}
    recovery={status.recovery}
    onVerified={refresh}
  />
{/if}

<style>
  :global(.app-page-shell.devices-settings) {
    max-width: 56rem;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-2);
  }

  .status-grid {
    display: grid;
    grid-template-columns: 1fr;
    margin: 0;
  }

  .status-item {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-bg-container-line);
    display: flex;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-3);
  }

  .status-item:last-child {
    border-bottom: 0;
  }

  .status-copy {
    flex: 1;
    min-width: 0;
  }

  .status-icon,
  .row-icon,
  .device-icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .status-icon.positive {
    background: var(--sable-success-container);
    color: var(--sable-success-on-container);
  }

  .status-icon :global(svg),
  .row-icon :global(svg),
  .device-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .device-name {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
  }

  dd {
    margin: calc(var(--space-1) / 2) 0 0;
  }

  .setting-row {
    align-items: stretch;
    border-top: var(--border-width) solid var(--sable-bg-container-line);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .setting-row > :global(.sable-button) {
    width: 100%;
  }

  .row-copy {
    flex: 1;
    min-width: 0;
  }

  .row-copy p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: calc(var(--space-1) / 2) 0 0;
  }

  .device-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .device + .device {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  .device-summary {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    min-height: calc(var(--control-height-medium) + var(--space-4));
    padding: var(--space-3);
  }

  .device-info {
    display: grid;
    flex: 1;
    gap: calc(var(--space-2) / 2);
    min-width: 0;
  }

  .device-name-line,
  .device-meta,
  .device-actions,
  .recovery-key-heading {
    align-items: center;
    display: flex;
    gap: var(--space-1);
  }

  .device-meta code {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .device-actions {
    flex: 0 0 auto;
    padding-left: calc(var(--control-height-medium) + var(--space-3));
    width: 100%;
  }

  .loading-state,
  .empty-state {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    gap: var(--space-2);
    justify-content: center;
    min-height: 5rem;
    padding: var(--space-3);
  }

  .empty-state {
    flex-direction: column;
  }

  .empty-state :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .empty-state p {
    margin: 0;
  }

  :global(.settings-error),
  :global(.recovery-key) {
    margin-bottom: var(--space-3);
  }

  :global(.sable-alert.recovery-key) {
    gap: var(--space-2);
    padding: var(--space-3);
  }

  .recovery-key-heading :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.recovery-key) code {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-warn-container-line);
    border-radius: var(--radius);
    display: block;
    overflow-wrap: anywhere;
    padding: var(--space-2);
    user-select: all;
  }

  @media (width >= 42rem) {
    .status-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .status-item {
      border-bottom: 0;
    }

    .setting-row {
      align-items: center;
      flex-direction: row;
    }

    .setting-row > :global(.sable-button) {
      width: auto;
    }

    .device-summary {
      align-items: center;
      flex-wrap: nowrap;
      padding: var(--space-2) var(--space-3);
    }

    .device-actions {
      padding-left: 0;
      width: auto;
    }
  }
</style>
