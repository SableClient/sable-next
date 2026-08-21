/**
 * Frame-stepped GIF playback. An `<img>` cannot be paused, and `drawImage` on an
 * animated image copies its first frame rather than the one on screen, so
 * holding the frame a reader stopped on means stepping the frames ourselves.
 * WebKit has no `ImageDecoder`: callers fall back to letting the `<img>` animate.
 */

/** A frame asking for no delay wants "as fast as possible", which renderers floor. */
const MIN_FRAME_MS = 20;
export const DEFAULT_FRAME_MS = 100;

export interface GifFrame {
  /** The caller owns this and must `close()` it once drawn. */
  image: VideoFrame;
  durationMs: number;
}

export interface GifPlayback {
  readonly frameCount: number;
  frame(index: number): Promise<GifFrame | null>;
  close(): void;
}

/**
 * Opens `url` for frame-by-frame playback, or resolves to `null` when the
 * platform cannot decode frames or the image is not an animation worth
 * stepping. Frames are decoded on demand, so a long GIF costs one frame of
 * memory rather than all of them.
 */
export async function openGifPlayback(url: string): Promise<GifPlayback | null> {
  if (typeof ImageDecoder !== 'function') return null;

  let decoder: ImageDecoder;
  try {
    const response = await fetch(url);
    decoder = new ImageDecoder({ data: await response.arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    await decoder.completed;
  } catch {
    return null;
  }

  const track = decoder.tracks.selectedTrack;
  if (!track?.animated || track.frameCount < 2) {
    decoder.close();
    return null;
  }

  return {
    frameCount: track.frameCount,
    async frame(index: number): Promise<GifFrame | null> {
      try {
        const { image } = await decoder.decode({ frameIndex: index });
        // `duration` is microseconds, and is null for a frame carrying no delay.
        const durationMs =
          image.duration === null
            ? DEFAULT_FRAME_MS
            : Math.max(image.duration / 1000, MIN_FRAME_MS);
        return { image, durationMs };
      } catch {
        return null;
      }
    },
    close(): void {
      decoder.close();
    },
  };
}
