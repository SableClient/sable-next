<script lang="ts">
  import type { CoreClient } from '$lib/core/client.svelte';
  import { provideCoreClient } from '$lib/core/context';
  import { untrack, type ComponentProps } from 'svelte';

  import RoomComposer from './RoomComposer.svelte';

  interface Props {
    core: CoreClient;
    composer: ComponentProps<typeof RoomComposer>;
  }

  let { core, composer }: Props = $props();

  provideCoreClient(untrack(() => core));
</script>

<RoomComposer {...composer} />
