<script lang="ts">
  import { mergeProps } from 'bits-ui';
  import ArticleNyTimesIcon from 'phosphor-svelte/lib/ArticleNyTimesIcon';
  import HighlighterIcon from 'phosphor-svelte/lib/HighlighterIcon';
  import TextTIcon from 'phosphor-svelte/lib/TextTIcon';
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
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import ComposerColorButton from './ComposerColorButton.svelte';
  import type { ActiveColors, ColorKind, FormatAction } from './editor/formatting';
  import { MARKDOWN_FORMATS } from './editor/markdown-format';

  interface Props {
    active: readonly FormatAction[];
    source: boolean;
    markdown: boolean;
    colors: ActiveColors;
    onFormat: (action: FormatAction) => void;
    onColor: (kind: ColorKind, value: string | null) => void;
    onToggleSource: () => void;
  }

  let { active, source, markdown, colors, onFormat, onColor, onToggleSource }: Props = $props();

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

  const primaryActions: FormatAction[] = [
    'strong',
    'em',
    'link',
    'bullet_list',
    'ordered_list',
    'blockquote',
  ];
  let available = $derived(
    markdown ? buttons.filter((button) => MARKDOWN_FORMATS.includes(button.action)) : buttons
  );
  let primary = $derived(available.filter((button) => primaryActions.includes(button.action)));
  let secondary = $derived(available.filter((button) => !primaryActions.includes(button.action)));
  let visible = $derived([...primary, ...secondary]);

  function scrollSideways(event: WheelEvent & { currentTarget: HTMLDivElement }): void {
    const bar = event.currentTarget;
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    if (bar.scrollWidth <= bar.clientWidth) return;
    event.preventDefault();
    bar.scrollLeft += event.deltaY;
  }
</script>

<div
  class="formatting"
  role="group"
  aria-label={$i18n.t('composer.formatting')}
  onwheel={scrollSideways}
>
  {#each visible as button (button.action)}
    <Tooltip label={$i18n.t(button.label)}>
      {#snippet trigger({ props })}
        <IconButton
          {...mergeProps(props, {
            onclick: () => {
              onFormat(button.action);
            },
          })}
          variant="ghost"
          size="small"
          class="format-button choice"
          label={$i18n.t(button.label)}
          aria-pressed={active.includes(button.action)}
        >
          <button.icon />
        </IconButton>
      {/snippet}
    </Tooltip>
  {/each}
  <ComposerColorButton
    label={$i18n.t('composer.textColor')}
    icon={TextTIcon}
    value={colors.fg}
    removable={!markdown}
    onPick={(value) => onColor('fg', value)}
  />
  <ComposerColorButton
    label={$i18n.t('composer.highlightColor')}
    icon={HighlighterIcon}
    value={colors.bg}
    removable={!markdown}
    onPick={(value) => onColor('bg', value)}
  />
  {#if source || !markdown}
    <Tooltip label={$i18n.t('composer.markdownSource')}>
      {#snippet trigger({ props })}
        <IconButton
          {...mergeProps(props, { onclick: onToggleSource })}
          variant="ghost"
          size="small"
          class="format-button choice"
          label={$i18n.t('composer.markdownSource')}
          aria-pressed={source}
        >
          {#if source}
            <ArticleNyTimesIcon />
          {:else}
            <MarkdownLogoIcon />
          {/if}
        </IconButton>
      {/snippet}
    </Tooltip>
  {/if}
</div>

<style>
  .formatting {
    align-items: center;
    display: flex;
    gap: var(--space-050);
    height: var(--target);
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .formatting::-webkit-scrollbar {
    display: none;
  }

  :global(.format-button) {
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
  }

  :global(.format-button)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.format-button svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
