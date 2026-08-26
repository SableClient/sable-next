<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Combobox from '#lib/ui/primitives/Combobox.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import { homeservers } from './homeservers.svelte.js';

  interface Props {
    id: string;
    value?: string;
    required?: boolean;
    disabled?: boolean;
    ariaInvalid?: boolean;
    oninput?: HTMLInputAttributes['oninput'];
    onblur?: HTMLInputAttributes['onblur'];
    onvaluechange?: (value: string) => void;
  }

  let {
    id,
    value = $bindable(''),
    required = false,
    disabled = false,
    ariaInvalid = false,
    oninput,
    onblur,
    onvaluechange,
  }: Props = $props();
</script>

{#if homeservers.allowCustom}
  <Combobox
    {id}
    bind:value
    items={homeservers.items}
    autocapitalize="off"
    autocorrect="off"
    autocomplete="url"
    {disabled}
    placeholder={homeservers.default}
    spellcheck={false}
    {required}
    {ariaInvalid}
    {oninput}
    {onblur}
    {onvaluechange}
  />
{:else}
  <Select
    {id}
    bind:value
    items={homeservers.items}
    {disabled}
    {required}
    placeholder={homeservers.default}
    onValueChange={onvaluechange}
  />
{/if}
