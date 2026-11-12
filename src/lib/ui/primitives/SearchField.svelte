<script lang="ts">
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import type { ClassValue, HTMLInputAttributes } from 'svelte/elements';
  import TextInput from './TextInput.svelte';

  type Props = Omit<HTMLInputAttributes, 'value' | 'class' | 'type' | 'aria-label'> & {
    label: string;
    value?: string;
    class?: ClassValue;
  };

  let {
    label,
    value = $bindable(''),
    placeholder = label,
    class: className = '',
    ...rest
  }: Props = $props();
</script>

<span class={['search-field', className]}>
  <MagnifyingGlassIcon aria-hidden="true" />
  <TextInput
    bind:value
    {...rest}
    type="search"
    autocomplete="off"
    aria-label={label}
    {placeholder}
  />
</span>

<style>
  .search-field {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
    width: 100%;
  }

  .search-field :global(svg) {
    color: var(--surface-var-on-container);
    height: var(--icon-size-small);
    inset-block-start: 50%;
    inset-inline-start: var(--control-padding-300);
    pointer-events: none;
    position: absolute;
    translate: 0 -50%;
    width: var(--icon-size-small);
  }

  .search-field :global(.text-input) {
    padding-inline-start: calc(var(--control-padding-300) * 2 + var(--icon-size-small));
  }
</style>
