<script lang="ts">
  import DialogFrame from './DialogFrame.svelte';

  let { open = $bindable(true) }: { open?: boolean } = $props();
</script>

<button type="button" onclick={() => (open = !open)}>Toggle</button>
<DialogFrame bind:open variant="sheet" label="Panel">
  <button type="button">Inside</button>
</DialogFrame>
