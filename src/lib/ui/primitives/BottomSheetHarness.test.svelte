<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';

  let { fullHeight = false, expandable = false }: { fullHeight?: boolean; expandable?: boolean } =
    $props();
</script>

<BottomSheet open label="Options" closeLabel="Close" {fullHeight} {expandable}>
  <div>
    <input aria-label="Filter" />
    {#each Array.from({ length: 12 }, (_, index) => index) as index (index)}
      <p><button type="button">Option {index + 1}</button></p>
    {/each}
  </div>
</BottomSheet>
