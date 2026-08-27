<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';

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

<div class="tool-stack">
  <p>{$i18n.t('settings.developerAccessTokenDescription')}</p>
  <div class="tool-actions">
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
  </div>
  {#if error}<Alert variant="critical">{$i18n.t('settings.developerAccessTokenFailed')}</Alert>{/if}
</div>

<style>
  .tool-stack {
    display: grid;
    gap: var(--space-2);
  }

  p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .tool-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
