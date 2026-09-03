<script lang="ts">
  import { Select as BitsSelect } from 'bits-ui';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import type { ClassValue } from 'svelte/elements';
  import './form-control.css';
  import './menu.css';

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
    <BitsSelect.Content sideOffset={4} class="sable-menu select-content">
      <BitsSelect.Viewport>
        {#each items as item (item.value)}
          <BitsSelect.Item
            value={item.value}
            label={item.label}
            disabled={item.disabled}
            class="sable-menu-item sable-choice"
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
    gap: var(--space-300);
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
    --menu-max-height: min(20rem, var(--bits-select-content-available-height));
    --menu-min-width: var(--bits-select-anchor-width);

    width: var(--bits-select-anchor-width);
  }
</style>
