<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Combobox from '#lib/ui/primitives/Combobox.svelte';
  import { HOMESERVER_ITEMS } from './homeservers';

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

<Combobox
  {id}
  bind:value
  items={HOMESERVER_ITEMS}
  autocapitalize="off"
  autocorrect="off"
  autocomplete="url"
  {disabled}
  placeholder="matrix.org"
  spellcheck={false}
  {required}
  {ariaInvalid}
  {oninput}
  {onblur}
  {onvaluechange}
/>
