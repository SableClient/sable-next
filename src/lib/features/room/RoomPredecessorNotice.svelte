<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    onOpen: () => void;
  }

  let { onOpen }: Props = $props();
</script>

<div class="predecessor">
  <p>{$i18n.t('timeline.predecessor')}</p>
  <Button size="small" variant="secondary" onclick={onOpen}>
    {$i18n.t('timeline.predecessorOpen')}
  </Button>
</div>

<style>
  .predecessor {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    padding: var(--space-300) var(--space-200);
    text-align: center;
  }

  .predecessor p {
    margin: 0;
  }
</style>
