<script lang="ts">
  import { Dialog } from 'bits-ui';

  import type { UserDeviceView, UserSecurityView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';

  interface Props {
    open: boolean;
    userId: string;
    displayName: string;
    onOpenChange: (open: boolean) => void;
  }

  let { open, userId, displayName, onOpenChange }: Props = $props();
  const core = useCoreClient();
  let security = $state<UserSecurityView | null>(null);
  let loading = $state(false);
  let error = $state(false);
  let verifying = $state(false);
  let accepting = $state(false);
  let blocking = $state<string | null>(null);
  let revision = $state(0);
  let completedFlow = $derived(
    core.verification?.userId === userId && core.verification.state.phase === 'done'
      ? core.verification.flowId
      : null
  );

  $effect(() => {
    if (!open) return;
    void completedFlow;
    void revision;
    const wanted = userId;
    let active = true;
    loading = true;
    error = false;
    security = null;
    core.commands
      .userSecurity(wanted)
      .then((value) => {
        if (active) security = value;
      })
      .catch(() => {
        if (active) error = true;
      })
      .finally(() => {
        if (active) loading = false;
      });
    return () => {
      active = false;
    };
  });

  async function verify(): Promise<void> {
    if (verifying) return;
    verifying = true;
    error = false;
    try {
      await core.requestVerification(userId);
      onOpenChange(false);
    } catch {
      error = true;
    } finally {
      verifying = false;
    }
  }

  async function setBlocked(device: UserDeviceView): Promise<void> {
    if (blocking !== null) return;
    blocking = device.device_id;
    error = false;
    try {
      await core.commands.setDeviceBlocked(userId, device.device_id, !device.blocked);
      device.blocked = !device.blocked;
    } catch {
      error = true;
    } finally {
      blocking = null;
    }
  }

  async function acceptIdentity(): Promise<void> {
    if (accepting) return;
    accepting = true;
    error = false;
    try {
      await core.commands.withdrawVerification(userId);
      revision += 1;
    } catch {
      error = true;
    } finally {
      accepting = false;
    }
  }
</script>

<DialogFrame {open} {onOpenChange} variant="settings" contentClass="user-security-dialog">
  <header class="security-header">
    <div>
      <Dialog.Title
        >{$i18n.t('timeline.profileEncryptionTitle', { name: displayName })}</Dialog.Title
      >
      <Dialog.Description>{$i18n.t('timeline.profileEncryptionDescription')}</Dialog.Description>
    </div>
    <Button size="small" onclick={() => onOpenChange(false)}>{$i18n.t('settings.close')}</Button>
  </header>

  <div class="security-body" style="overflow-y: auto">
    {#if loading}
      <div class="security-loading" role="status"><Spinner /></div>
    {:else if security}
      <section class="security-identity" aria-labelledby="security-identity-title">
        <div class="security-row">
          <h3 id="security-identity-title">{$i18n.t('timeline.profileIdentity')}</h3>
          <StatusBadge
            label={$i18n.t(
              security.verification === 'verified'
                ? 'settings.verified'
                : security.verification === 'unverified'
                  ? 'settings.notVerified'
                  : 'settings.unavailable'
            )}
            variant={security.verification === 'verified'
              ? 'success'
              : security.verification === 'unverified'
                ? 'warning'
                : 'neutral'}
          />
        </div>
        {#if security.verification_violation}
          <Alert variant="critical">{$i18n.t('timeline.profileIdentityChanged')}</Alert>
          <Button onclick={() => void acceptIdentity()} disabled={accepting}>
            {$i18n.t('timeline.profileAcceptIdentity')}
          </Button>
        {/if}
        {#if security.verification !== 'verified'}
          <Button
            variant="primary"
            onclick={() => void verify()}
            disabled={verifying || security.verification === 'unknown'}
          >
            {$i18n.t('timeline.profileVerify')}
          </Button>
        {/if}
      </section>

      <section aria-labelledby="security-devices-title">
        <h3 id="security-devices-title">{$i18n.t('timeline.profileDevices')}</h3>
        <p class="security-note">{$i18n.t('timeline.profileDevicePolicy')}</p>
        {#if security.devices.length === 0}
          <p class="security-empty">{$i18n.t('timeline.profileNoDevices')}</p>
        {:else}
          <ul class="security-devices">
            {#each security.devices as device (device.device_id)}
              <li>
                <div class="security-device-name">
                  <strong>{device.display_name?.trim() || $i18n.t('settings.unnamedDevice')}</strong
                  >
                  <code>{device.device_id}</code>
                </div>
                <div class="security-device-actions">
                  {#if !device.cross_signed}
                    <StatusBadge
                      label={$i18n.t('timeline.profileDeviceUnsigned')}
                      variant="warning"
                    />
                  {/if}
                  {#if device.blocked}
                    <StatusBadge
                      label={$i18n.t('timeline.profileDeviceBlocked')}
                      variant="critical"
                    />
                  {/if}
                  <Button
                    size="small"
                    onclick={() => void setBlocked(device)}
                    disabled={blocking !== null}
                  >
                    {$i18n.t(
                      device.blocked
                        ? 'timeline.profileUnblockDevice'
                        : 'timeline.profileBlockDevice'
                    )}
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if error}<Alert variant="critical" role="alert">{$i18n.t('settings.actionFailed')}</Alert
      >{/if}
  </div>
</DialogFrame>

<style>
  .security-header,
  .security-row,
  .security-devices li {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .security-header {
    border-bottom: var(--border-width) solid var(--surface-container-line);
    padding: var(--space-400);
  }

  :global(.user-security-dialog) {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .security-body {
    min-height: 0;
  }

  .security-header :global(h2),
  h3,
  .security-header :global(p) {
    margin: 0;
  }

  .security-header :global(p),
  .security-note,
  .security-empty,
  code {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  section {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  .security-identity {
    border-bottom: var(--border-width) solid var(--surface-container-line);
  }

  .security-loading {
    display: grid;
    min-height: 10rem;
    place-items: center;
  }

  .security-note,
  .security-empty {
    margin: 0;
  }

  .security-devices {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .security-devices li {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-300);
    padding: var(--space-300);
  }

  .security-device-name {
    display: grid;
    min-width: 0;
  }

  .security-device-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--space-200);
  }

  code {
    overflow-wrap: anywhere;
  }
</style>
