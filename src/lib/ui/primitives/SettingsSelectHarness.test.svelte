<script lang="ts">
  import { setContext } from 'svelte';
  import Select from './Select.svelte';
  import { settingsChoices } from './Switcher.svelte';
  let { items, forceDropdown = false } = $props<{
    items: { value: string; label: string }[];
    forceDropdown?: boolean;
  }>();
  setContext(settingsChoices, true);
</script>

<Select {items} {forceDropdown} value={items[0].value} aria-label="Setting" />
