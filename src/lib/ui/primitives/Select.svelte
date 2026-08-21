<script lang="ts">
  import { Select as BitsSelect } from 'bits-ui';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import type { ClassValue } from 'svelte/elements';
  import './form-control.css';

  type Item = {
    value: string;
    label: string;
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
    'aria-label': ariaLabel,
    onValueChange,
  }: Props = $props();
</script>

<BitsSelect.Root type="single" {items} bind:value {name} {required} {disabled} {onValueChange}>
  <BitsSelect.Trigger {id} aria-label={ariaLabel} class={['form-control', 'select', className]}>
    <BitsSelect.Value {placeholder} />
    <CaretDownIcon class="select-caret" aria-hidden="true" />
  </BitsSelect.Trigger>
  <BitsSelect.Portal>
    <BitsSelect.Content sideOffset={4} class="select-content">
      <BitsSelect.Viewport>
        {#each items as item (item.value)}
          <BitsSelect.Item
            value={item.value}
            label={item.label}
            disabled={item.disabled}
            class="select-item"
          >
            {#snippet children({ selected })}
              <span>{item.label}</span>
              {#if selected}<CheckIcon class="select-check" aria-hidden="true" />{/if}
            {/snippet}
          </BitsSelect.Item>
        {/each}
      </BitsSelect.Viewport>
    </BitsSelect.Content>
  </BitsSelect.Portal>
</BitsSelect.Root>

<style>
  :global(.select) {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    text-align: left;
    width: 100%;
  }

  :global(.select-caret),
  :global(.select-check) {
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.select-content) {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    max-height: min(20rem, var(--bits-select-content-available-height));
    min-width: var(--bits-select-anchor-width);
    overflow: auto;
    padding: var(--space-1);
    width: var(--bits-select-anchor-width);
    z-index: var(--layer-menu);
  }

  :global(.select-item) {
    align-items: center;
    border-radius: calc(var(--radius) - var(--border-width));
    cursor: pointer;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    min-height: var(--control-height-medium);
    padding: 0 var(--control-padding-inline);
  }

  :global(.select-item[data-highlighted]) {
    background: var(--sable-surface-container-hover);
  }

  :global(.select-item[data-disabled]) {
    cursor: default;
    opacity: 0.65;
  }
</style>
