<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  const core = useCoreClient();
  let copied = $state(false);
  let error = $state(false);

  async function copyToken(): Promise<void> {
    try {
      const token = await core.commands.accessToken();
      if (!token) throw new Error('No access token');
      await navigator.clipboard.writeText(token);
      copied = true;
      error = false;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      error = true;
      copied = false;
    }
  }
</script>

<ul class="settings">
  <SettingsRow
    title={$i18n.t('settings.developerAccessTokenTitle')}
    description={$i18n.t('settings.developerAccessTokenDescription')}
    icon={KeyIcon}
  >
    <Button
      variant="secondary"
      size="small"
      onclick={() => void copyToken()}
      disabled={!core.session}
    >
      {$i18n.t(
        copied ? 'settings.developerAccessTokenCopied' : 'settings.developerAccessTokenCopy'
      )}
    </Button>
  </SettingsRow>
</ul>
{#if error}<Alert variant="critical">{$i18n.t('settings.developerAccessTokenFailed')}</Alert>{/if}

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
