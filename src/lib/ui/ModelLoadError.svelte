<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { loadModelForApp } from '#lib/model/model-load.svelte.js';

  import BootFailureCard from './BootFailureCard.svelte';
  import Button from './primitives/Button.svelte';

  let retrying = $state(false);

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await loadModelForApp();
    } catch (error) {
      console.warn('[sable] the model failed to load again', error);
    } finally {
      retrying = false;
    }
  }
</script>

<BootFailureCard title={i18n.t('app.modelLoadFailed')} detail={i18n.t('app.modelLoadFailedDetail')}>
  <Button disabled={retrying} onclick={() => void retry()}>{i18n.t('common.tryAgain')}</Button>
</BootFailureCard>
