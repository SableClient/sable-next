<script lang="ts">
  import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import QrLinkDialog from '#lib/features/qr-login/QrLinkDialog.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  let oauth = $state(false);
  let linkingDevice = $state(false);

  $effect(() => {
    void core.commands.devices().then(
      ({ oauth: supported }) => {
        oauth = supported;
      },
      () => {}
    );
  });
</script>

{#if oauth}
  <SettingsSection headingId="account-devices" title={$i18n.t('settings.signedInDevices')}>
    <ul class="settings-rows">
      <SettingsRow
        title={$i18n.t('qrLogin.linkDevice')}
        description={$i18n.t('qrLogin.linkDeviceHint')}
      >
        <Button onclick={() => (linkingDevice = true)}>
          <QrCodeIcon size={16} aria-hidden="true" />{$i18n.t('qrLogin.linkDeviceAction')}
        </Button>
      </SettingsRow>
    </ul>
  </SettingsSection>
{/if}

<QrLinkDialog bind:open={linkingDevice} mode="grant" />
