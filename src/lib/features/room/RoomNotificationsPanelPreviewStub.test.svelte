<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    fallback,
    timeAction,
  }: { fallback: Snippet; timeAction: { label: string; run: () => void } } = $props();
</script>

{@render fallback()}
<button type="button" onclick={timeAction.run}>{timeAction.label}</button>
