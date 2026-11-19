<script lang="ts">
  import type { Snippet } from 'svelte';

  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { createRpc } from '#src/generated/protocol';

  let { children }: { children: Snippet } = $props();

  provideCoreClient({ rpc: createRpc(() => new Promise(() => {})) } as unknown as CoreClient);
</script>

{@render children()}
