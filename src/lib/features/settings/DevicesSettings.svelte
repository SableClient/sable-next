<script lang="ts">
  import type { DeviceView } from '@/generated/DeviceView';
  import type { EncryptionStatusView } from '@/generated/EncryptionStatusView';
  import type { VerificationView } from '@/generated/VerificationView';
  import { CoreError } from '@/transport';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();
  let devices = $state<DeviceView[]>([]);
  let status = $state<EncryptionStatusView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let displayName = $state('');
  let password = $state('');
  let deleting = $state<string | null>(null);
  let verification = $state<{
    flowId: string;
    state: VerificationView;
    initiatedByUs: boolean;
  } | null>(null);

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
      error = messageFor(cause);
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

  async function startVerification(): Promise<void> {
    if (!core.session?.user_id) return;
    error = null;
    try {
      const flowId = await core.requestVerification(core.session.user_id);
      verification = { flowId, state: { phase: 'requested', is_self: true }, initiatedByUs: true };
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function accept(): Promise<void> {
    if (!verification || !core.session?.user_id) return;
    try {
      await core.acceptVerification(core.session.user_id, verification.flowId);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function confirm(): Promise<void> {
    if (!verification || !core.session?.user_id) return;
    try {
      await core.confirmVerification(core.session.user_id, verification.flowId);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function cancel(mismatch = false): Promise<void> {
    if (!verification || !core.session?.user_id) return;
    try {
      await core.cancelVerification(core.session.user_id, verification.flowId, mismatch);
      verification = null;
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  $effect(() => {
    void refresh();
    return core.subscribeEvents((event) => {
      if (event.type === 'encryption_status') status = event.status;
      if (event.type === 'verification' && event.user_id === core.session?.user_id) {
        verification = {
          flowId: event.flow_id,
          state: event.state,
          initiatedByUs: verification?.flowId === event.flow_id && verification.initiatedByUs,
        };
        if (event.state.phase === 'done') void refresh();
      }
    });
  });
</script>

<svelte:head><title>{$i18n.t('settings.devices')} · Sable</title></svelte:head>

<main class="settings-page">
  <header>
    <h1>{$i18n.t('settings.devicesTitle')}</h1>
    <p>{$i18n.t('settings.devicesDescription')}</p>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

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
          <dd class:good={status.verification === 'verified'}>
            {verificationLabel(status.verification)}
          </dd>
        </div>
        <div>
          <dt>{$i18n.t('settings.recovery')}</dt>
          <dd class:good={status.recovery === 'enabled'}>{recoveryLabel(status.recovery)}</dd>
        </div>
        <div>
          <dt>{$i18n.t('settings.crossSigning')}</dt>
          <dd class:good={status.cross_signing_ready}>
            {status.cross_signing_ready
              ? $i18n.t('settings.ready')
              : $i18n.t('settings.verifyOtherDevice')}
          </dd>
        </div>
      </dl>
      {#if status.verification !== 'verified'}
        <div class="callout">
          <div>
            <strong>{$i18n.t('settings.verifyThisDevice')}</strong>
            <p>{$i18n.t('settings.verifySignedInDevice')}</p>
          </div>
          <Button onclick={startVerification}>{$i18n.t('settings.verify')}</Button>
        </div>
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
                  <button type="button" class="text-button" onclick={() => (editing = null)}
                    >{$i18n.t('settings.cancel')}</button
                  >
                </form>
              {:else}
                <strong
                  >{device.display_name || $i18n.t('settings.unnamedDevice')}
                  {#if device.is_own}<span class="current">{$i18n.t('settings.currentDevice')}</span
                    >{/if}</strong
                >
                <span class:verified={device.is_verified}
                  >{device.is_verified
                    ? $i18n.t('settings.verified')
                    : $i18n.t('settings.notVerified')}</span
                >
                <code>{device.device_id}</code>
              {/if}
            </div>
            {#if !device.is_own && editing !== device.device_id}
              <div class="actions">
                <button
                  type="button"
                  class="text-button"
                  onclick={() => {
                    beginRename(device);
                  }}>{$i18n.t('settings.rename')}</button
                ><button
                  type="button"
                  class="danger-button"
                  onclick={() => {
                    deleting = device.device_id;
                  }}>{$i18n.t('settings.remove')}</button
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
                <Button type="submit">{$i18n.t('settings.removeDevice')}</Button>
                <button type="button" class="text-button" onclick={() => (deleting = null)}
                  >{$i18n.t('settings.cancel')}</button
                >
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if verification}
    <section class="verification" aria-live="polite" aria-labelledby="verify-heading">
      <h2 id="verify-heading">{$i18n.t('settings.verification')}</h2>
      {#if verification.state.phase === 'requested'}
        {#if verification.initiatedByUs}
          <p>{$i18n.t('settings.acceptOtherDevice')}</p>
        {:else}
          <p>{$i18n.t('settings.verificationRequested')}</p>
          <Button onclick={accept}>{$i18n.t('settings.acceptVerification')}</Button>
        {/if}
      {:else if verification.state.phase === 'waiting'}
        <p>{$i18n.t('settings.waiting')}</p>
      {:else if verification.state.phase === 'compare'}
        <p>{$i18n.t('settings.compareEmoji')}</p>
        <div class="emoji" aria-label={$i18n.t('settings.verificationEmoji')}>
          {#each verification.state.emojis as emoji (emoji.symbol)}<span title={emoji.description}
              >{emoji.symbol}</span
            >{/each}
        </div>
        <p class="decimals">{verification.state.decimals.join(' · ')}</p>
        <Button onclick={confirm}>{$i18n.t('settings.theyMatch')}</Button>
        <button type="button" class="danger-button" onclick={() => void cancel(true)}
          >{$i18n.t('settings.theyDoNotMatch')}</button
        >
      {:else if verification.state.phase === 'confirmed'}
        <p>{$i18n.t('settings.finishing')}</p>
      {:else if verification.state.phase === 'cancelled'}
        <p>{$i18n.t('settings.verificationCancelled', { reason: verification.state.reason })}</p>
      {/if}
      {#if verification.state.phase !== 'done'}<button
          type="button"
          class="text-button"
          onclick={() => void cancel()}>{$i18n.t('settings.cancelVerification')}</button
        >{/if}
    </section>
  {/if}
</main>

<style>
  .settings-page {
    margin: 0 auto;
    max-width: 52rem;
    overflow: auto;
    padding: 2rem;
    width: 100%;
  }

  header {
    margin-bottom: 2rem;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    font-size: var(--font-size-xlarge);
  }

  h2 {
    font-size: var(--font-size-large);
  }

  section {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    margin-top: 1rem;
    padding: 1.25rem;
  }

  .section-heading,
  .callout,
  .device,
  .actions {
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
  }

  .section-heading p,
  .callout p {
    margin-bottom: 0;
  }

  .status-grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(3, 1fr);
    margin: 1.25rem 0;
  }

  dt {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  dd {
    font-weight: var(--font-weight-bold);
    margin: 0.125rem 0 0;
  }

  .good,
  .verified {
    color: var(--sable-success-main);
  }

  .callout,
  .verification {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
  }

  .device-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .device {
    border-top: 1px solid var(--sable-bg-container-line);
    flex-wrap: wrap;
    padding: 1rem 0;
  }

  .device-info {
    display: grid;
    gap: 0.25rem;
  }

  code {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .current {
    color: var(--sable-primary-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .text-button,
  .danger-button {
    background: none;
    border: 0;
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    padding: 0.5rem;
  }

  .danger-button {
    color: var(--sable-crit-main);
  }

  form {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  label {
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.25rem;
  }

  .remove-confirmation {
    background: var(--sable-surface-container);
    padding: 0.75rem;
    width: 100%;
  }

  .error {
    background: var(--sable-crit-container);
    border-radius: var(--radius);
    color: var(--sable-crit-on-container);
    padding: 0.75rem;
  }

  .emoji {
    display: flex;
    font-size: 2rem;
    gap: 0.5rem;
    margin: 1rem 0;
  }

  .decimals {
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-bold);
  }

  @media (width < 42rem) {
    .settings-page {
      padding: 1rem;
    }

    .status-grid {
      grid-template-columns: 1fr;
    }

    .section-heading,
    .callout {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
