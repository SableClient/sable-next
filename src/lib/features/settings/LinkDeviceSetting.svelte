<script lang="ts">
  import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';

  import { i18n } from '#lib/i18n.js';
  import QrLinkDialog from '#lib/features/qr-login/QrLinkDialog.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  let linkingDevice = $state(false);
</script>

<ul class="settings-rows">
  <SettingsRow
    id="link-device"
    title={i18n.t('qrLogin.titleGrant')}
    description={i18n.t('qrLogin.linkDeviceHint')}
  >
    <Button onclick={() => (linkingDevice = true)}>
      <QrCodeIcon size={16} aria-hidden="true" />{i18n.t('qrLogin.linkDeviceAction')}
    </Button>
  </SettingsRow>
</ul>

<QrLinkDialog bind:open={linkingDevice} mode="grant" />
