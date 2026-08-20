<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { untrack, type ComponentProps } from 'svelte';

  import type { ComposerContext } from './composer-context';
  import RoomComposer from './RoomComposer.svelte';

  interface Props {
    core: CoreClient;
    composer: ComponentProps<typeof RoomComposer>;
    registerReply?: (reply: () => void) => void;
  }

  let { core, composer, registerReply }: Props = $props();
  let context = $state<ComposerContext | null>(
    untrack(() => composer.context as ComposerContext | null)
  );

  provideCoreClient(untrack(() => core));

  function reply(): void {
    const nextContext = composer.context as ComposerContext | null;
    if (!nextContext || nextContext.kind !== 'reply') return;
    context = { ...nextContext };
  }

  untrack(() => registerReply?.(reply));
</script>

<RoomComposer {...composer} {context} />
