<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { ComposerContext } from './composer-context';

  interface Props {
    context: ComposerContext;
    onCancel?: () => void;
  }

  let { context, onCancel }: Props = $props();
</script>

<div class="context">
  <span class="context-kind">
    {context.kind === 'edit'
      ? $i18n.t('composer.editing')
      : $i18n.t('composer.replyingTo', { name: context.sender ?? '' })}
  </span>
  <span class="context-body">{context.body}</span>
  <IconButton
    size="small"
    variant="ghost"
    label={$i18n.t('composer.cancelContext')}
    onclick={onCancel}
  >
    <XIcon />
  </IconButton>
</div>

<style>
  .context {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    margin-inline: 0.375rem;
    min-width: 0;
    padding: 0.375rem 0 0.3125rem;
  }

  .context-kind {
    color: var(--sable-primary-main);
    flex: 0 0 auto;
    font-weight: var(--font-weight-medium);
  }

  .context-body {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
