<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    message: string;
    disabled?: boolean;
    onRetry: () => void;
  }

  let { message, disabled = false, onRetry }: Props = $props();
</script>

<Alert variant="critical" role="alert">
  <p>{message}</p>
  <div class="alert-actions">
    <Button size="small" {disabled} onclick={onRetry}>{i18n.t('common.tryAgain')}</Button>
  </div>
</Alert>

<style>
  .alert-actions {
    display: flex;
  }
</style>
