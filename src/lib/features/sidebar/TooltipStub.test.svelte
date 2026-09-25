<script lang="ts">
  import type { Snippet } from 'svelte';

  let { trigger }: { trigger: Snippet<[{ props: Record<string, unknown> }]> } = $props();
</script>

{@render trigger({ props: {} })}
