<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { grantPermission, permissionGranted } from './present';
  import '#lib/ui/primitives/settings-row.css';

  let granted = $state(true);

  $effect(() => {
    let alive = true;
    void permissionGranted().then((allowed) => {
      if (alive) granted = allowed;
    });

    return () => {
      alive = false;
    };
  });
</script>

{#if !granted}
  <div class="settings-form">
    <Alert variant="warning">
      <p>{$i18n.t('settings.notificationPermission')}</p>
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          void grantPermission().then((allowed) => {
            granted = allowed;
          });
        }}>{$i18n.t('settings.notificationPermissionAction')}</Button
      >
    </Alert>
  </div>
{/if}
