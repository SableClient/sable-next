<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import CodeViewControls from '#lib/ui/CodeViewControls.svelte';
  import { Copied } from '#lib/ui/copied.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  interface Props {
    block: HTMLPreElement;
    figure: HTMLElement;
    language: string | null;
    numbered: boolean;
    collapsible: boolean;
  }

  let { block, figure, language, numbered, collapsible }: Props = $props();
  let wrapped = $state(untrack(() => language === null));
  let lineNumbers = $state(untrack(() => numbered));
  let collapsed = $state(untrack(() => collapsible));
  const copied = new Copied();

  $effect(() => {
    figure.toggleAttribute('data-wrapped', wrapped);
    figure.toggleAttribute('data-line-numbers', lineNumbers);
    figure.toggleAttribute('data-collapsed', collapsed);
  });
</script>

<div class="code-head">
  <span class="code-language">{language ?? i18n.t('timeline.codeLabel')}</span>
  <TooltipProvider>
    <CodeViewControls bind:wrapped bind:lineNumbers numberable={numbered} />
    <PanelHeaderButton
      label={copied.value ? i18n.t('common.copied') : i18n.t('common.copy')}
      onclick={() => copied.copy(block.textContent)}
    >
      {#if copied.value}<CheckIcon />{:else}<CopyIcon />{/if}
    </PanelHeaderButton>
  </TooltipProvider>
  {#if collapsible}
    <Button
      variant="ghost"
      size="small"
      aria-expanded={!collapsed}
      onclick={() => (collapsed = !collapsed)}
    >
      {i18n.t(collapsed ? 'timeline.expandCode' : 'timeline.collapseCode')}
    </Button>
  {/if}
</div>

<style>
  .code-head {
    --ghost-active: var(--surface-container-active);
    --ghost-hover: var(--surface-container-hover);

    align-items: center;
    background: var(--surface-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    color: var(--surface-on-container);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    padding-inline: var(--space-200) var(--space-100);
  }

  .code-language {
    flex: 1;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
