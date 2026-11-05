/**
 * Frame-stepped animation playback: an `<img>` cannot pause and `drawImage` copies frame 0.
 * Without `ImageDecoder` (WebKit) callers let the `<img>` animate.
 */

/** A frame asking for no delay wants "as fast as possible", which renderers floor. */
const MIN_FRAME_MS = 20;
export const DEFAULT_FRAME_MS = 100;

export interface GifFrame {
  image: VideoFrame;
  durationMs: number;
  release(): void;
}

export interface GifPlayback {
  readonly frameCount: number;
  frame(index: number): Promise<GifFrame | null>;
  close(): void;
}

async function ownsFrames(decoder: ImageDecoder): Promise<boolean> {
  try {
    const first = await decoder.decode({ frameIndex: 0 });
    const second = await decoder.decode({ frameIndex: 0 });
    if (first.image === second.image) return false;
    first.image.close();
    second.image.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens `url` for frame stepping, or `null` when frames cannot be decoded or it is not an animation. Frames decode on demand.
 */
export async function openGifPlayback(
  url: string,
  type = 'image/gif'
): Promise<GifPlayback | null> {
  if (typeof ImageDecoder !== 'function') return null;

  let decoder: ImageDecoder;
  try {
    const response = await fetch(url);
    decoder = new ImageDecoder({ data: await response.arrayBuffer(), type });
    await decoder.tracks.ready;
    await decoder.completed;
  } catch (error) {
    console.debug('[sable media] the animation could not be decoded', error);
    return null;
  }

  const track = decoder.tracks.selectedTrack;
  if (!track?.animated || track.frameCount < 2) {
    decoder.close();
    return null;
  }

  const owned = await ownsFrames(decoder);

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
        return {
          image,
          durationMs,
          release: (): void => {
            if (owned) image.close();
          },
        };
      } catch (error) {
        console.debug('[sable media] an animation frame could not be decoded', error);
        return null;
      }
    },
    close(): void {
      decoder.close();
    },
  };
}
