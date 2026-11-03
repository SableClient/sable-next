<script lang="ts">
  import { reads } from './media-image-reads.test-support.js';

  let { source }: { source: string } = $props();
  let shown = $derived.by(() => {
    reads.count += 1;
    return source;
  });
</script>

<span data-source={shown}></span>
