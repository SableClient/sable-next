<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';

  interface Props {
    open?: boolean;
    source: string;
  }

  let { open = $bindable(false), source }: Props = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      copied = true;
    } catch (error) {
      console.debug('[sable timeline] clipboard unavailable', error);
    }
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('timeline.sourceTitle')}>
  <h2>{$i18n.t('timeline.sourceTitle')}</h2>
  <pre class="source">{source}</pre>
  <FormActions>
    <Button variant="secondary" onclick={copy}>
      {copied ? $i18n.t('timeline.copied') : $i18n.t('timeline.copy')}
    </Button>
    <Button
      variant="ghost"
      onclick={() => {
        open = false;
      }}>{$i18n.t('timeline.cancel')}</Button
    >
  </FormActions>
</DialogFrame>

<style>
  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0 0 var(--space-300);
  }

  .source {
    background: var(--sable-surface-var-container);
    border-radius: var(--radii-400);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0 0 var(--space-400);
    max-height: 22rem;
    overflow: auto;
    overflow-wrap: anywhere;
    padding: var(--space-300);
    white-space: pre-wrap;
  }
</style>
