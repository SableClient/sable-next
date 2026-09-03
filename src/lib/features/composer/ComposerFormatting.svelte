<script lang="ts">
  import ArticleNyTimesIcon from 'phosphor-svelte/lib/ArticleNyTimesIcon';
  import CaretCircleDownIcon from 'phosphor-svelte/lib/CaretCircleDownIcon';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import CodeBlockIcon from 'phosphor-svelte/lib/CodeBlockIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import ListNumbersIcon from 'phosphor-svelte/lib/ListNumbersIcon';
  import MarkdownLogoIcon from 'phosphor-svelte/lib/MarkdownLogoIcon';
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon';
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
  import TableIcon from 'phosphor-svelte/lib/TableIcon';
  import TextSubscriptIcon from 'phosphor-svelte/lib/TextSubscriptIcon';
  import TextSuperscriptIcon from 'phosphor-svelte/lib/TextSuperscriptIcon';
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon';
  import TextHOneIcon from 'phosphor-svelte/lib/TextHOneIcon';
  import TextHTwoIcon from 'phosphor-svelte/lib/TextHTwoIcon';
  import TextHThreeIcon from 'phosphor-svelte/lib/TextHThreeIcon';
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon';
  import TextStrikethroughIcon from 'phosphor-svelte/lib/TextStrikethroughIcon';
  import TextUnderlineIcon from 'phosphor-svelte/lib/TextUnderlineIcon';
  import type { Component } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { FormatAction } from './editor/formatting';

  interface Props {
    active: readonly FormatAction[];
    source: boolean;
    onFormat: (action: FormatAction) => void;
    onToggleSource: () => void;
  }

  let { active, source, onFormat, onToggleSource }: Props = $props();

  const buttons: { action: FormatAction; label: string; icon: Component }[] = [
    { action: 'strong', label: 'composer.bold', icon: TextBIcon },
    { action: 'em', label: 'composer.italic', icon: TextItalicIcon },
    { action: 'underline', label: 'composer.underline', icon: TextUnderlineIcon },
    { action: 'strike', label: 'composer.strike', icon: TextStrikethroughIcon },
    { action: 'code', label: 'composer.code', icon: CodeIcon },
    { action: 'spoiler', label: 'composer.spoiler', icon: EyeSlashIcon },
    { action: 'sub', label: 'composer.subscript', icon: TextSubscriptIcon },
    { action: 'sup', label: 'composer.superscript', icon: TextSuperscriptIcon },
    { action: 'link', label: 'composer.link', icon: LinkSimpleIcon },
    { action: 'bullet_list', label: 'composer.bulletList', icon: ListBulletsIcon },
    { action: 'ordered_list', label: 'composer.orderedList', icon: ListNumbersIcon },
    { action: 'blockquote', label: 'composer.quote', icon: QuotesIcon },
    { action: 'code_block', label: 'composer.codeBlock', icon: CodeBlockIcon },
    { action: 'heading1', label: 'composer.heading1', icon: TextHOneIcon },
    { action: 'heading2', label: 'composer.heading2', icon: TextHTwoIcon },
    { action: 'heading3', label: 'composer.heading3', icon: TextHThreeIcon },
    { action: 'horizontal_rule', label: 'composer.horizontalRule', icon: MinusIcon },
    { action: 'table', label: 'composer.table', icon: TableIcon },
    { action: 'details', label: 'composer.details', icon: CaretCircleDownIcon },
  ];
</script>

<div class="formatting" role="group" aria-label={$i18n.t('composer.formatting')}>
  {#each buttons as button (button.action)}
    <IconButton
      variant="ghost"
      size="small"
      class="format-button sable-choice"
      label={$i18n.t(button.label)}
      aria-pressed={active.includes(button.action)}
      onclick={() => {
        onFormat(button.action);
      }}
    >
      <button.icon />
    </IconButton>
  {/each}
  <IconButton
    variant="ghost"
    size="small"
    class="format-button sable-choice"
    label={$i18n.t('composer.markdownSource')}
    aria-pressed={source}
    onclick={onToggleSource}
  >
    {#if source}
      <ArticleNyTimesIcon />
    {:else}
      <MarkdownLogoIcon />
    {/if}
  </IconButton>
</div>

<style>
  .formatting {
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: var(--space-050);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding: var(--space-150) var(--space-200);
    scrollbar-width: none;
  }

  .formatting::-webkit-scrollbar {
    display: none;
  }

  :global(.format-button) {
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    width: var(--target);
  }

  :global(.format-button svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
