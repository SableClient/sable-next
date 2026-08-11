<script lang="ts">
  import { Combobox as BitsCombobox } from 'bits-ui';
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';
  import TextInput from './TextInput.svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  type Item = {
    value: string;
    label: string;
    disabled?: boolean;
  };

  type Props = {
    id: string;
    items: Item[];
    value?: string;
    required?: boolean;
    autocomplete?: BitsCombobox.InputProps['autocomplete'];
    autocapitalize?: BitsCombobox.InputProps['autocapitalize'];
    autocorrect?: BitsCombobox.InputProps['autocorrect'];
    spellcheck?: BitsCombobox.InputProps['spellcheck'];
    placeholder?: string;
    disabled?: boolean;
    ariaInvalid?: boolean;
    oninput?: HTMLInputAttributes['oninput'];
    onblur?: HTMLInputAttributes['onblur'];
  };

  let {
    id,
    items,
    value = $bindable(''),
    required = false,
    autocomplete,
    autocapitalize,
    autocorrect,
    spellcheck,
    disabled = false,
    placeholder,
    ariaInvalid = false,
    oninput,
    onblur,
  }: Props = $props();

  let searchValue = $state('');

  const filteredItems = $derived(
    searchValue === ''
      ? items
      : items.filter((item) => item.label.toLowerCase().includes(searchValue.toLowerCase()))
  );

  function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
    searchValue = event.currentTarget.value;
    value = searchValue;
    oninput?.(event);
  }

  function handleOpenChange(open: boolean) {
    if (!open) searchValue = '';
  }
</script>

<BitsCombobox.Root
  type="single"
  {items}
  bind:value
  {required}
  onOpenChange={handleOpenChange}
  allowDeselect={false}
  {disabled}
>
  <div class="combobox-input">
    <BitsCombobox.Input
      {id}
      {autocomplete}
      {autocapitalize}
      {autocorrect}
      {spellcheck}
      {placeholder}
      {required}
      {disabled}
      aria-invalid={ariaInvalid}
      defaultValue={items.find((item) => item.value === value)?.label ?? value}
      oninput={handleInput}
      {onblur}
    >
      {#snippet child({ props })}
        <TextInput {...props} />
      {/snippet}
    </BitsCombobox.Input>

    <BitsCombobox.Trigger aria-label="Show options">
      {#snippet child({ props })}
        <button {...props} class="combobox-trigger"><CaretDownIcon class="combobox-icon" /></button>
      {/snippet}
    </BitsCombobox.Trigger>
  </div>

  <BitsCombobox.Portal>
    <BitsCombobox.Content sideOffset={4}>
      {#snippet child({ wrapperProps, props, open })}
        {#if open && filteredItems.length > 0}
          <div {...wrapperProps}>
            <div {...props} class="combobox-menu">
              {#each filteredItems as item (item.value)}
                <BitsCombobox.Item value={item.value} label={item.label} disabled={item.disabled}>
                  {#snippet child({ props })}
                    <div {...props} class="combobox-option">
                      {item.label}
                    </div>
                  {/snippet}
                </BitsCombobox.Item>
              {/each}
            </div>
          </div>
        {/if}
      {/snippet}
    </BitsCombobox.Content>
  </BitsCombobox.Portal>
</BitsCombobox.Root>

<style>
  .combobox-input {
    --input-padding-right: 2.75rem;

    display: grid;
    position: relative;
  }

  .combobox-trigger {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    height: 100%;
    justify-content: center;
    padding: 0;
    position: absolute;
    right: 0;
    top: 0;
    width: 2.75rem;
  }

  .combobox-trigger:hover {
    color: var(--sable-bg-on-container);
  }

  .combobox-trigger:active {
    transform: scale(0.92);
  }

  .combobox-trigger:focus-visible {
    border-radius: var(--radius);
    outline: 2px solid var(--sable-focus-ring);
    outline-offset: -4px;
  }

  .combobox-trigger:disabled {
    cursor: default;
    opacity: 0.65;
  }

  :global(.combobox-icon) {
    display: block;
    height: 18px;
    width: 18px;
  }

  .combobox-trigger[data-state='open'] :global(.combobox-icon) {
    transform: rotate(180deg);
  }

  .combobox-menu {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    overflow: hidden;
    width: var(--bits-combobox-anchor-width);
  }

  .combobox-option {
    padding: 0.625rem 0.875rem;
  }

  .combobox-option[data-highlighted] {
    background: var(--sable-surface-container-hover);
  }

  @media (prefers-reduced-motion: no-preference) {
    .combobox-trigger {
      transition:
        color var(--motion-normal) ease,
        transform var(--motion-fast) ease;
    }

    :global(.combobox-icon) {
      transition: transform var(--motion-normal) ease;
    }

    .combobox-option {
      transition: background-color var(--motion-fast) ease;
    }
  }
</style>
