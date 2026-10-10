<script lang="ts">
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import type { RoomSummary } from '#src/generated/protocol';
  import { provideCoreClient } from '#lib/core/context.js';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.js';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import { untrack, type ComponentProps } from 'svelte';

  import type { ComposerContext } from './composer-context';
  import RoomComposer from './RoomComposer.svelte';

  interface Props {
    core: CoreClient;
    rooms?: RoomSummary[];
    composer: ComponentProps<typeof RoomComposer>;
    registerReply?: (reply: () => void) => void;
    registerContext?: (set: (next: ComposerContext | null) => void) => void;
    registerRoom?: (set: (roomId: string) => void) => void;
  }

  let { core, rooms, composer, registerReply, registerContext, registerRoom }: Props = $props();
  let context = $state.raw<ComposerContext | null>(
    untrack(() => composer.context as ComposerContext | null)
  );

  provideCoreClient(untrack(() => core));
  const roomList = untrack(() => new RoomList(core));
  roomList.rooms = untrack(() => rooms ?? []);
  provideRoomList(roomList);
  providePersonaStore(untrack(() => new PersonaStore(core)));

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
  untrack(() =>
    registerRoom?.((roomId) => {
      composer = { ...composer, roomId };
    })
  );
</script>

<TooltipProvider>
  <RoomComposer {...composer} {context} />
</TooltipProvider>
