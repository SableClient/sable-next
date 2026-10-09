<script lang="ts">
  import { Select as BitsSelect } from 'bits-ui';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import type { ClassValue } from 'svelte/elements';
  import { getContext } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import BottomSheet from './BottomSheet.svelte';
  import Switcher, { settingsChoices } from './Switcher.svelte';
  import './form-control.css';
  import './menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  type Item = {
    value: string;
    label: string;
    image?: string;
    imageClass?: ClassValue;
    labelClass?: ClassValue;
    disabled?: boolean;
  };

  type Props = {
    items: Item[];
    value?: string;
    id?: string;
    name?: string;
    required?: boolean;
    disabled?: boolean;
    placeholder?: string;
    class?: ClassValue;
    forceDropdown?: boolean;
    'aria-label'?: string;
    onValueChange?: (value: string) => void;
  };

  let {
    items,
    value = $bindable(''),
    id,
    name,
    required = false,
    disabled = false,
    placeholder,
    class: className = '',
    forceDropdown = false,
    'aria-label': ariaLabel,
    onValueChange,
  }: Props = $props();

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const inlineChoices = getContext<boolean>(settingsChoices) ?? false;
  const useSwitcher = $derived(
    !forceDropdown &&
      inlineChoices &&
      Boolean(ariaLabel || placeholder) &&
      items.length >= 2 &&
      items.length <= 3 &&
      !items.some((item) => item.image)
  );
  let sheetOpen = $state(false);
  let selectedLabel = $derived(items.find((item) => item.value === value)?.label);

  function choose(next: string): void {
    sheetOpen = false;
    if (next === value) return;
    value = next;
    onValueChange?.(next);
  }
</script>

{#snippet itemContent(item: Item, selected: boolean)}
  {#if item.image}
    <img
      class={['select-item-image', item.imageClass]}
      src={item.image}
      alt=""
      aria-hidden="true"
    />
  {/if}
  <span class={['selection-label', item.labelClass]}>{item.label}</span>
  {#if selected}<CheckIcon class="select-check" aria-hidden="true" />{/if}
{/snippet}

{#if useSwitcher}
  <Switcher
    {id}
    {items}
    bind:value
    label={ariaLabel ?? placeholder ?? ''}
    {name}
    {required}
    {disabled}
    {onValueChange}
  />
{:else if !appLayout.matches}
  <button
    type="button"
    {id}
    class={['form-control', 'select', className]}
    aria-label={ariaLabel}
    aria-haspopup="dialog"
    aria-expanded={sheetOpen}
    {disabled}
    onclick={() => {
      sheetOpen = true;
    }}
  >
    <span class="select-text" class:select-placeholder={selectedLabel === undefined}
      >{selectedLabel ?? placeholder ?? ''}</span
    >
    <CaretDownIcon class="select-caret" aria-hidden="true" />
  </button>
  {#if name}<input type="hidden" {name} {value} {required} />{/if}
  <BottomSheet
    bind:open={sheetOpen}
    label={ariaLabel ?? placeholder ?? ''}
    closeLabel={$i18n.t('common.close')}
  >
    <div class="select-sheet" role="radiogroup" aria-label={ariaLabel}>
      {#if ariaLabel}<p class="select-sheet-title">{ariaLabel}</p>{/if}
      {#each items as item (item.value)}
        <button
          type="button"
          role="radio"
          aria-checked={item.value === value}
          class="menu-item choice select-sheet-row"
          disabled={item.disabled}
          onclick={() => {
            choose(item.value);
          }}
        >
          {@render itemContent(item, item.value === value)}
        </button>
      {/each}
    </div>
  </BottomSheet>
{:else}
  <BitsSelect.Root type="single" {items} bind:value {name} {required} {disabled} {onValueChange}>
    <BitsSelect.Trigger {id} aria-label={ariaLabel} class={['form-control', 'select', className]}>
      <BitsSelect.Value
        class={['select-text', { 'select-placeholder': selectedLabel === undefined }]}
        {placeholder}
      />
      <CaretDownIcon class="select-caret" aria-hidden="true" />
    </BitsSelect.Trigger>
    <BitsSelect.Portal>
      <BitsSelect.Content
        sideOffset={4}
        class="menu-surface select-content"
        {...overlayLayer()}
        {@attach scrollHint}
      >
        <BitsSelect.Viewport>
          {#each items as item (item.value)}
            <BitsSelect.Item
              value={item.value}
              label={item.label}
              disabled={item.disabled}
              class="menu-item choice"
            >
              {#snippet children({ selected })}
                {@render itemContent(item, selected)}
              {/snippet}
            </BitsSelect.Item>
          {/each}
        </BitsSelect.Viewport>
      </BitsSelect.Content>
    </BitsSelect.Portal>
  </BitsSelect.Root>
{/if}

<style>
  :global(.select) {
    --form-control-padding-inline: var(--space-200);
    --form-control-padding-inline-end: var(--space-200);

    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--space-300);
    height: var(--control-height-300);
    justify-content: space-between;
    min-height: var(--control-height-300);
    position: relative;
    text-align: left;
    width: 100%;
  }

  :global(.select::after) {
    content: '';
    inset-block: calc((var(--target-hit) - var(--control-height-300)) / -2);
    inset-inline: 0;
    position: absolute;
  }

  :global(.select-text) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-transform: none;
    white-space: nowrap;
  }

  :global(.selection-label) {
    text-transform: capitalize;
  }

  :global(.selection-label.literal-label) {
    text-transform: none;
  }

  :global(.select-caret),
  :global(.select-check) {
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .select-item-image {
    border-radius: 22.5%;
    height: 48px;
    object-fit: cover;
    width: 48px;
  }

  :global(.select-placeholder) {
    color: inherit;
    opacity: var(--opacity-placeholder);
  }

  .select-sheet {
    display: grid;
  }

  .select-sheet-title {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0 0 var(--space-200);
    padding: 0 var(--space-300);
  }

  .select-sheet-row {
    --menu-item-height: max(var(--control-height-400), var(--target-hit));

    border-radius: var(--radius);
    font-size: var(--font-size-label);
    width: 100%;
  }

  .select-sheet-row :global(.selection-label) {
    flex: 1;
    text-align: start;
  }

  :global(.menu-surface.select-content) {
    --menu-max-height: min(20rem, var(--bits-select-content-available-height));

    width: var(--bits-select-anchor-width);
  }
</style>
