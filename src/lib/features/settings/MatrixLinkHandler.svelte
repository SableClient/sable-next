<script lang="ts">
  import { resolve } from '$app/paths';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const handlerUrl = `${resolve('/(app)/to/[...permalink]', { permalink: '' })}?uri=%s`;
</script>

<ul class="settings-rows">
  <SettingsRow
    id="matrix-link-handler"
    title={i18n.t('settings.matrixLinkHandler')}
    description={i18n.t('settings.matrixLinkHandlerHint')}
  >
    <Button onclick={() => navigator.registerProtocolHandler('matrix', handlerUrl)}
      >{i18n.t('settings.matrixLinkHandlerAction')}</Button
    >
  </SettingsRow>
</ul>
