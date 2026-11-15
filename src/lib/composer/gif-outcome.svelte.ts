import { SvelteMap } from 'svelte/reactivity';

import { measureAttachment } from '#lib/core/attachment-info.js';
import { gifMaxBytes, playsAsGif } from '#lib/model/model.js';

const outcomes = new SvelteMap<File, boolean>();
const started = new WeakSet<File>();

/**
 * What the core will decide for a video left on automatic, so the composer
 * can show it before sending. Unknown until the file has been read.
 */
export function gifOutcome(file: File): boolean | undefined {
  if (!started.has(file)) {
    started.add(file);
    void resolve(file);
  }
  return outcomes.get(file);
}

async function resolve(file: File): Promise<void> {
  try {
    if (file.size > gifMaxBytes()) {
      outcomes.set(file, false);
      return;
    }
    const [{ info }, bytes] = await Promise.all([
      measureAttachment(file),
      file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    ]);
    outcomes.set(file, playsAsGif(bytes, info?.duration_ms ?? null));
  } catch (error) {
    console.debug('[sable composer] the clip could not be checked for GIF playback', error);
  }
}
