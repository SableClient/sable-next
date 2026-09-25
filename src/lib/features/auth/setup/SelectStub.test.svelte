<script lang="ts">
  let {
    id,
    value,
    items,
    onValueChange,
  }: {
    id: string;
    value: string;
    items: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  } = $props();
</script>

<div data-select={id} data-value={value}>
  {#each items as item (item.value)}
    <button type="button" onclick={() => onValueChange(item.value)}>{item.label}</button>
  {/each}
</div>
