import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type VideoStreamer = {
  commands: Partial<Pick<CoreCommands, 'streamVideo' | 'videoStreamMime'>>;
};

export function videoStreamingSupported(core: VideoStreamer): boolean {
  return (
    typeof core.commands.streamVideo === 'function' &&
    typeof core.commands.videoStreamMime === 'function'
  );
}

/** `appendBuffer` throws while the buffer is updating, so appends queue. */
function appender(buffer: SourceBuffer): {
  push: (chunk: Uint8Array) => void;
  idle: () => Promise<void>;
} {
  const queue: Uint8Array[] = [];
  let waiting: (() => void)[] = [];

  const drain = (): void => {
    if (buffer.updating) return;
    const next = queue.shift();
    if (next === undefined) {
      const settled = waiting;
      waiting = [];
      for (const resolve of settled) resolve();
      return;
    }
    try {
      buffer.appendBuffer(next as unknown as BufferSource);
    } catch {
      queue.length = 0;
    }
  };

  buffer.addEventListener('updateend', drain);
  return {
    push: (chunk) => {
      queue.push(chunk);
      drain();
    },
    idle: () =>
      queue.length === 0 && !buffer.updating
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push(resolve)),
  };
}

/** An object URL backed by a `MediaSource` that fills as the re-encode runs. */
export async function videoStreamUrl(core: VideoStreamer, source: string): Promise<string> {
  const { streamVideo, videoStreamMime } = core.commands;
  if (typeof streamVideo !== 'function' || typeof videoStreamMime !== 'function') {
    throw new Error('no native video re-encoder');
  }
  if (typeof MediaSource === 'undefined') throw new Error('no MediaSource');

  const mime = await videoStreamMime();
  if (!MediaSource.isTypeSupported(mime)) throw new Error(`unsupported stream type: ${mime}`);

  const media = new MediaSource();
  const url = URL.createObjectURL(media);

  const open = new Promise<SourceBuffer>((resolve, reject) => {
    media.addEventListener(
      'sourceopen',
      () => {
        try {
          resolve(media.addSourceBuffer(mime));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      { once: true }
    );
  });

  // `sourceopen` waits on the element attaching, which happens after this returns.
  void open.then(async (buffer) => {
    const { push, idle } = appender(buffer);
    try {
      await streamVideo(source, (chunk) => {
        push(chunk);
      });
      await idle();
    } finally {
      if (media.readyState === 'open') media.endOfStream();
    }
  });

  return url;
}
