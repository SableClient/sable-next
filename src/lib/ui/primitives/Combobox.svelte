<script lang="ts">
  import { Combobox as BitsCombobox } from 'bits-ui';
  import { i18n } from '#lib/i18n.js';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import TextInput from './TextInput.svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  /** Free text is a valid value, so the input always shows `value` itself.
      `label` is the list's display and filter text and must not diverge from it. */
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
    onvaluechange?: (value: string) => void;
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
    onvaluechange,
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
  inputValue={value}
  {required}
  onOpenChange={handleOpenChange}
  onValueChange={onvaluechange}
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
      oninput={handleInput}
      {onblur}
    >
      {#snippet child({ props })}
        <TextInput {...props} />
      {/snippet}
    </BitsCombobox.Input>

    <BitsCombobox.Trigger aria-label={$i18n.t('combobox.showOptions')}>
      {#snippet child({ props })}
        <button {...props} class="combobox-trigger"><CaretDownIcon class="combobox-icon" /></button>
      {/snippet}
    </BitsCombobox.Trigger>
  </div>

  <BitsCombobox.Portal>
    <BitsCombobox.Content sideOffset={4}>
      {#snippet child({ wrapperProps, props, open })}
        {#if open && filteredItems.length > 0}
          <div {...wrapperProps} class="combobox-positioner">
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
    --form-control-padding-inline-end: var(--control-height-medium);

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
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: -4px;
  }

  .combobox-trigger:disabled {
    cursor: default;
    opacity: 0.65;
  }

  :global(.combobox-icon) {
    display: block;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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

  .combobox-positioner {
    position: relative;
    z-index: var(--layer-menu);
  }

  .combobox-option {
    padding: 0.625rem 0.875rem;
  }

  .combobox-option[data-highlighted] {
    background: var(--sable-surface-container-hover);
  }

  .combobox-option:active {
    background: var(--sable-surface-container-active);
  }

  @media (prefers-reduced-motion: no-preference) {
    .combobox-trigger {
      transition:
        color var(--motion-normal) var(--motion-easing-standard),
        transform var(--motion-fast) var(--motion-easing-standard);
    }

    :global(.combobox-icon) {
      transition: transform var(--motion-normal) var(--motion-easing-standard);
    }

    .combobox-option:active {
      transition: background-color var(--motion-fast) var(--motion-easing-standard);
    }
  }
</style>
