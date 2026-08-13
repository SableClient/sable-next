<script lang="ts">
  import type { DeviceView } from '@/generated/DeviceView';
  import type { EncryptionStatusView } from '@/generated/EncryptionStatusView';
  import { CoreError } from '@/transport';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import AppPageShell from '$lib/ui/primitives/AppPageShell.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import StatusBadge from '$lib/ui/primitives/StatusBadge.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();
  let devices = $state<DeviceView[]>([]);
  let status = $state<EncryptionStatusView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let displayName = $state('');
  let password = $state('');
  let recoveryKey = $state('');
  let recovering = $state(false);
  let managingRecovery = $state(false);
  let newRecoveryKey = $state<string | null>(null);
  let deleting = $state<string | null>(null);

  const verificationLabel = (value: EncryptionStatusView['verification']) =>
    value === 'verified'
      ? t('settings.verified')
      : value === 'unverified'
        ? t('settings.notVerified')
        : t('settings.unavailable');
  const recoveryLabel = (value: NonNullable<EncryptionStatusView>['recovery']) =>
    value === 'enabled'
      ? t('settings.recoveryEnabled')
      : value === 'incomplete'
        ? t('settings.recoveryNeeded')
        : t('settings.notConfigured');

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
      status = nextStatus;
      devices = nextDevices;
    } catch (cause) {
      error = messageFor(cause);
    } finally {
      loading = false;
    }
  }

  function beginRename(device: DeviceView): void {
    editing = device.device_id;
    displayName = device.display_name ?? '';
  }

  async function saveName(deviceId: string): Promise<void> {
    try {
      await core.renameDevice(deviceId, displayName.trim());
      editing = null;
      await refresh();
    } catch (cause) {
      error = recoveryMessageFor(cause);
    }
  }

  async function removeDevice(deviceId: string): Promise<void> {
    try {
      await core.deleteDevice(deviceId, password || null);
      deleting = null;
      password = '';
      await refresh();
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function recoverIdentity(): Promise<void> {
    const key = recoveryKey.trim();
    if (!key) return;

    recovering = true;
    error = null;
    try {
      await core.recoverIdentity(key);
      recoveryKey = '';
      await refresh();
    } catch (cause) {
      error = messageFor(cause);
    } finally {
      recovering = false;
    }
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

  async function startVerification(): Promise<void> {
    if (!core.session?.user_id) return;
    error = null;
    try {
      await core.requestVerification(core.session.user_id);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  $effect(() => {
    void refresh();
    return core.subscribeEvents((event) => {
      if (event.type === 'encryption_status') status = event.status;
    });
  });
</script>

<AppPageShell
  title={$i18n.t('settings.devicesTitle')}
  description={$i18n.t('settings.devicesDescription')}
>
  {#if error}<Alert class="settings-error" variant="critical" role="alert">{error}</Alert>{/if}

  <section aria-labelledby="encryption-heading">
    <div class="section-heading">
      <div>
        <h2 id="encryption-heading">{$i18n.t('settings.encryption')}</h2>
      </div>
      <Button onclick={refresh} disabled={loading}>{$i18n.t('settings.refresh')}</Button>
    </div>
    {#if status}
      <dl class="status-grid">
        <div>
          <dt>{$i18n.t('settings.thisDevice')}</dt>
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
        <div>
          <dt>{$i18n.t('settings.recovery')}</dt>
          <dd>
            <StatusBadge
              variant={status.recovery === 'enabled'
                ? 'success'
                : status.recovery === 'incomplete'
                  ? 'warning'
                  : 'neutral'}
              label={recoveryLabel(status.recovery)}
            />
          </dd>
        </div>
        <div>
          <dt>{$i18n.t('settings.crossSigning')}</dt>
          <dd>
            <StatusBadge
              variant={status.cross_signing_ready ? 'success' : 'warning'}
              label={status.cross_signing_ready
                ? $i18n.t('settings.ready')
                : $i18n.t('settings.verifyOtherDevice')}
            />
          </dd>
        </div>
      </dl>
      {#if status.verification !== 'verified'}
        <Alert class="settings-callout" variant="info">
          <div>
            <strong>{$i18n.t('settings.verifyThisDevice')}</strong>
            <p>{$i18n.t('settings.verifySignedInDevice')}</p>
          </div>
          <Button onclick={startVerification}>{$i18n.t('settings.verify')}</Button>
        </Alert>
      {/if}
      {#if status.recovery === 'incomplete'}
        <form
          class="recovery-form"
          onsubmit={(event) => {
            event.preventDefault();
            void recoverIdentity();
          }}
        >
          <label for="recovery-key">{$i18n.t('settings.recoveryKey')}</label>
          <TextInput
            id="recovery-key"
            bind:value={recoveryKey}
            autocomplete="off"
            autocapitalize="none"
            disabled={recovering}
            spellcheck={false}
            type="password"
            placeholder={$i18n.t('settings.recoveryKeyPlaceholder')}
          />
          <Button type="submit" disabled={recovering || !recoveryKey.trim()}>
            {$i18n.t('settings.recover')}
          </Button>
        </form>
      {/if}
      {#if status.recovery === 'disabled'}
        <Alert class="settings-callout" variant="info">
          <div>
            <strong>{$i18n.t('settings.setUpRecovery')}</strong>
            <p>{$i18n.t('settings.setUpRecoveryDescription')}</p>
          </div>
          <Button loading={managingRecovery} onclick={() => void manageRecovery()}>
            {$i18n.t('settings.setUpRecovery')}
          </Button>
        </Alert>
      {:else if status.recovery === 'enabled'}
        <Alert class="settings-callout" variant="info">
          <div>
            <strong>{$i18n.t('settings.resetRecoveryKey')}</strong>
            <p>{$i18n.t('settings.resetRecoveryKeyDescription')}</p>
          </div>
          <Button loading={managingRecovery} onclick={() => void manageRecovery(true)}>
            {$i18n.t('settings.resetRecoveryKey')}
          </Button>
        </Alert>
      {/if}
    {:else if loading}
      <p>{$i18n.t('settings.loadingEncryption')}</p>
    {/if}
  </section>

  <section aria-labelledby="devices-heading">
    <div class="section-heading">
      <div>
        <h2 id="devices-heading">{$i18n.t('settings.signedInDevices')}</h2>
        <p>{$i18n.t('settings.removeUnusedDevices')}</p>
      </div>
    </div>
    {#if loading}<p>{$i18n.t('settings.loadingDevices')}</p>
    {:else if devices.length === 0}<p>{$i18n.t('settings.noDevices')}</p>
    {:else}
      <ul class="device-list">
        {#each devices as device (device.device_id)}
          <li class="device">
            <div class="device-info">
              {#if editing === device.device_id}
                <form
                  onsubmit={(event) => {
                    event.preventDefault();
                    void saveName(device.device_id);
                  }}
                >
                  <label for={'device-' + device.device_id}>{$i18n.t('settings.deviceName')}</label>
                  <TextInput id={'device-' + device.device_id} bind:value={displayName} required />
                  <Button type="submit">{$i18n.t('settings.save')}</Button>
                  <Button variant="ghost" size="small" onclick={() => (editing = null)}
                    >{$i18n.t('settings.cancel')}</Button
                  >
                </form>
              {:else}
                <strong
                  >{device.display_name || $i18n.t('settings.unnamedDevice')}
                  {#if device.is_own}<span class="current">{$i18n.t('settings.currentDevice')}</span
                    >{/if}</strong
                >
                <StatusBadge
                  variant={device.is_verified ? 'success' : 'warning'}
                  label={device.is_verified
                    ? $i18n.t('settings.verified')
                    : $i18n.t('settings.notVerified')}
                />
                <code>{device.device_id}</code>
              {/if}
            </div>
            {#if !device.is_own && editing !== device.device_id}
              <div class="actions">
                <Button
                  variant="ghost"
                  size="small"
                  onclick={() => {
                    beginRename(device);
                  }}>{$i18n.t('settings.rename')}</Button
                ><Button
                  variant="danger"
                  size="small"
                  onclick={() => {
                    deleting = device.device_id;
                  }}>{$i18n.t('settings.remove')}</Button
                >
              </div>
            {/if}
            {#if deleting === device.device_id}
              <form
                class="remove-confirmation"
                onsubmit={(event) => {
                  event.preventDefault();
                  void removeDevice(device.device_id);
                }}
              >
                <label for={'password-' + device.device_id}>{$i18n.t('settings.password')}</label>
                <TextInput
                  id={'password-' + device.device_id}
                  type="password"
                  bind:value={password}
                  autocomplete="current-password"
                />
                <Button type="submit" variant="danger">{$i18n.t('settings.removeDevice')}</Button>
                <Button variant="ghost" size="small" onclick={() => (deleting = null)}
                  >{$i18n.t('settings.cancel')}</Button
                >
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if newRecoveryKey}
    <section class="recovery-key" aria-labelledby="recovery-key-heading">
      <h2 id="recovery-key-heading">{$i18n.t('settings.saveRecoveryKey')}</h2>
      <p>{$i18n.t('settings.saveRecoveryKeyDescription')}</p>
      <code>{newRecoveryKey}</code>
      <Button onclick={() => (newRecoveryKey = null)}>{$i18n.t('settings.savedRecoveryKey')}</Button
      >
    </section>
  {/if}
</AppPageShell>

<style>
  h2,
  p {
    margin-top: 0;
  }

  h2 {
    font-size: var(--font-size-large);
  }

  section {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    margin-top: var(--space-3);
    padding: var(--space-4);
  }

  .section-heading,
  .device,
  .actions {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  .section-heading p,
  :global(.sable-alert.settings-callout p) {
    margin-bottom: 0;
  }

  .status-grid {
    display: grid;
    gap: var(--space-2);
    grid-template-columns: repeat(3, 1fr);
    margin: var(--space-4) 0;
  }

  dt {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  dd {
    font-weight: var(--font-weight-bold);
    margin: 0.125rem 0 0;
  }

  :global(.sable-alert.settings-callout) {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  .device-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .device {
    border-top: 1px solid var(--sable-bg-container-line);
    flex-wrap: wrap;
    min-height: var(--control-height-large);
    padding: var(--space-3) 0;
  }

  .device:first-child {
    border-top: 0;
  }

  .device-info {
    display: grid;
    gap: 0.25rem;
  }

  code {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .recovery-key code {
    display: block;
    margin: var(--space-3) 0;
    overflow-wrap: anywhere;
    user-select: all;
  }

  .current {
    color: var(--sable-primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  form {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  label {
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.25rem;
  }

  .remove-confirmation {
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    padding: var(--space-2);
    width: 100%;
  }

  :global(.settings-error) {
    margin-bottom: var(--space-3);
  }

  @media (width < 42rem) {
    .status-grid {
      grid-template-columns: 1fr;
    }

    .section-heading,
    :global(.sable-alert.settings-callout) {
      align-items: stretch;
      flex-direction: column;
    }

    form {
      align-items: stretch;
      flex-direction: column;
    }

    form :global(.sable-button) {
      width: 100%;
    }
  }
</style>
