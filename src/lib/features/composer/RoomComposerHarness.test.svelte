<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { untrack, type ComponentProps } from 'svelte';

  import type { ComposerContext } from './composer-context';
  import RoomComposer from './RoomComposer.svelte';

  interface Props {
    core: CoreClient;
    composer: ComponentProps<typeof RoomComposer>;
    registerReply?: (reply: () => void) => void;
    registerContext?: (set: (next: ComposerContext | null) => void) => void;
  }

  let { core, composer, registerReply, registerContext }: Props = $props();
  let context = $state<ComposerContext | null>(
    untrack(() => composer.context as ComposerContext | null)
  );

  provideCoreClient(untrack(() => core));
  provideRoomList(untrack(() => new RoomList(core)));

  function reply(): void {
    const nextContext = composer.context as ComposerContext | null;
    if (!nextContext || nextContext.kind !== 'reply') return;
    context = { ...nextContext };
  }

  untrack(() => registerReply?.(reply));
  untrack(() =>
    registerContext?.((next) => {
      context = next;
    })
  );
</script>

<RoomComposer {...composer} {context} />
