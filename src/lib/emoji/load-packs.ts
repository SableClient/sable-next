import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { ImagePackView } from '#src/generated/protocol';

/** Show cached packs immediately, then replace the snapshot with complete server state. */
export async function loadPacks(
  commands: Pick<CoreCommands, 'imagePacks'>,
  roomId: string,
  apply: (packs: ImagePackView[]) => void
): Promise<void> {
  const cached = await commands.imagePacks(roomId, true).catch((): ImagePackView[] => []);
  if (cached.length > 0) apply(cached);
  try {
    apply(await commands.imagePacks(roomId));
  } catch (error) {
    if (cached.length === 0) throw error;
  }
}
