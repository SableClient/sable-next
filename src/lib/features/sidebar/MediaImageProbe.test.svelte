<script lang="ts" module>
  export const reads = { count: 0 };
</script>

<script lang="ts">
  let { source }: { source: string } = $props();
  let shown = $derived.by(() => {
    reads.count += 1;
    return source;
  });
</script>

<span data-source={shown}></span>
