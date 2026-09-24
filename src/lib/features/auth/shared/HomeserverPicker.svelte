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
    onsettle?: () => void;
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
    onsettle,
  }: Props = $props();

  const SETTLE_MS = 600;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(settleTimer));

  function handleInput(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
    oninput?.(event);
    clearTimeout(settleTimer);
    if (onsettle && event.currentTarget.value.trim()) settleTimer = setTimeout(onsettle, SETTLE_MS);
  }

  function handleBlur(event: FocusEvent & { currentTarget: EventTarget & HTMLInputElement }) {
    clearTimeout(settleTimer);
    onblur?.(event);
  }

  function handleValueChange(selected: string) {
    clearTimeout(settleTimer);
    onvaluechange?.(selected);
  }
</script>

{#if homeservers.allowCustom}
  <Combobox
    {id}
    bind:value
    items={homeservers.items}
    autocapitalize="off"
    autocorrect="off"
    autocomplete="url"
    inputmode="url"
    {disabled}
    placeholder={homeservers.default}
    spellcheck={false}
    {required}
    {ariaInvalid}
    oninput={handleInput}
    onblur={handleBlur}
    onvaluechange={handleValueChange}
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
