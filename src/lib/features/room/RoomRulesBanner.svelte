<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    onView: () => void;
  }

  let { onView }: Props = $props();
</script>

<Alert role="region" aria-label={i18n.t('room.rulesTitle')} class="rules-banner">
  <p>{i18n.t('room.rulesBanner')}</p>
  <Button onclick={onView}>{i18n.t('room.rulesView')}</Button>
</Alert>

<style>
  :global(.rules-banner) {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    margin: var(--space-300);
  }

  p {
    margin: 0;
  }

  @media (--app-layout) {
    :global(.rules-banner) {
      grid-template-columns: 1fr auto;
    }
  }
</style>
