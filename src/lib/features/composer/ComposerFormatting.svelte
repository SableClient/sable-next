<script lang="ts">
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon';
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon';
  import TextStrikethroughIcon from 'phosphor-svelte/lib/TextStrikethroughIcon';
  import type { Component } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { FormatAction } from './editor/formatting';

  interface Props {
    active: readonly FormatAction[];
    onFormat: (action: FormatAction) => void;
  }

  let { active, onFormat }: Props = $props();

  const buttons: { action: FormatAction; label: string; icon: Component }[] = [
    { action: 'strong', label: 'composer.bold', icon: TextBIcon },
    { action: 'em', label: 'composer.italic', icon: TextItalicIcon },
    { action: 'strike', label: 'composer.strike', icon: TextStrikethroughIcon },
    { action: 'code', label: 'composer.code', icon: CodeIcon },
    { action: 'bullet_list', label: 'composer.bulletList', icon: ListBulletsIcon },
    { action: 'blockquote', label: 'composer.quote', icon: QuotesIcon },
  ];
</script>

<div class="formatting" role="group" aria-label={$i18n.t('composer.formatting')}>
  {#each buttons as button (button.action)}
    <IconButton
      variant="ghost"
      size="small"
      class="format-button"
      label={$i18n.t(button.label)}
      aria-pressed={active.includes(button.action)}
      onclick={() => {
        onFormat(button.action);
      }}
    >
      <button.icon />
    </IconButton>
  {/each}
</div>

<style>
  .formatting {
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
  }

  :global(.format-button) {
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    height: var(--target);
    min-height: var(--target);
    width: var(--target);
  }

  :global(.format-button[aria-pressed='true']) {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  :global(.format-button svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
