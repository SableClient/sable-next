<script lang="ts">
  import { Combobox as BitsCombobox } from 'bits-ui';
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';
  import TextInput from './TextInput.svelte';

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
  }

  function handleOpenChange(open: boolean) {
    if (!open) searchValue = '';
  }
</script>

<BitsCombobox.Root type="single" {items} bind:value {required} onOpenChange={handleOpenChange}>
  <div class="combobox-input">
    <BitsCombobox.Input
      {id}
      {autocomplete}
      {autocapitalize}
      {autocorrect}
      {spellcheck}
      {required}
      defaultValue={items.find((item) => item.value === value)?.label ?? value}
      oninput={handleInput}
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

    transition:
      color 120ms ease,
      transform 100ms ease;
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

  :global(.combobox-icon) {
    display: block;
    height: 18px;
    width: 18px;

    transition: transform 120ms ease;
  }

  .combobox-trigger[data-state='open'] :global(.combobox-icon) {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .combobox-trigger,
    :global(.combobox-icon) {
      transition: none;
    }
  }
</style>
