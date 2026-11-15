import { measureAttachment } from '#lib/core/attachment-info.js';
import { gifMaxBytes, playsAsGif } from '#lib/model/model.js';

/** What the core will decide for a video left on automatic, read ahead of sending. */
export async function clipPlaysAsGif(file: File): Promise<boolean> {
  if (file.size > gifMaxBytes()) return false;
  const [{ info }, buffer] = await Promise.all([measureAttachment(file), file.arrayBuffer()]);
  return playsAsGif(new Uint8Array(buffer), info?.duration_ms ?? null);
}
