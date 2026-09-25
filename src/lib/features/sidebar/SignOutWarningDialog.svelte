<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';

  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import type { SignOutGuard } from './sign-out-guard.svelte.js';

  interface Props {
    guard: SignOutGuard;
  }

  let { guard }: Props = $props();

  let recoveryAction = $derived(
    guard.risk === 'unverified'
      ? 'settings.logoutWarning.verify'
      : guard.risk === 'no_recovery' || guard.risk === 'no_backup'
        ? 'settings.logoutWarning.setUpRecovery'
        : null
  );

  function openSecurity(): void {
    guard.dismiss();
    void afterOverlayPops().then(() => goto(resolve(`settings/${SETTINGS_DEVICES_SECTION}`)));
  }
</script>

<ConfirmDialog
  open={guard.risk !== null}
  title={$i18n.t('settings.logoutWarning.title')}
  description={guard.risk ? $i18n.t(`settings.logoutWarning.${guard.risk}`) : null}
  confirmLabel={$i18n.t('settings.logoutWarning.confirm')}
  busy={guard.signingOut}
  onConfirm={() => void guard.confirm()}
  onCancel={() => guard.dismiss()}
  onOpenChange={(open) => {
    if (!open && !guard.signingOut) guard.dismiss();
  }}
>
  <div class="sign-out-recovery">
    {#if recoveryAction}
      <Button type="button" variant="primary" disabled={guard.signingOut} onclick={openSecurity}
        >{$i18n.t(recoveryAction)}</Button
      >
    {/if}
    <Button type="button" variant="secondary" disabled={guard.signingOut} onclick={openSecurity}
      >{$i18n.t('settings.logoutWarning.exportKeys')}</Button
    >
  </div>
</ConfirmDialog>

<style>
  .sign-out-recovery {
    display: grid;
    gap: var(--space-200);
  }
</style>
