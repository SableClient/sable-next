import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type VideoStreamer = {
  commands: Partial<Pick<CoreCommands, 'streamVideo' | 'videoStreamMime'>>;
};

let streamMime = $state<string | null>(null);
let probed = false;

/** False until the backend answers: the wrappers exist where the command does not. */
export function videoStreamingSupported(core: VideoStreamer): boolean {
  const { streamVideo, videoStreamMime } = core.commands;
  if (typeof streamVideo !== 'function' || typeof videoStreamMime !== 'function') return false;
  if (!probed) {
    probed = true;
    void videoStreamMime().then(
      (mime) => {
        streamMime = mime;
      },
      () => {}
    );
  }
  return streamMime !== null;
}

/** Test seam: the probe answers once per process. */
export function resetVideoStreaming(): void {
  streamMime = null;
  probed = false;
}

let nextStreamId = 1;

/** An object URL for an attachment the webview cannot decode. */
export async function videoStreamUrl(
  core: VideoStreamer,
  source: string,
  _currentTime: () => number = () => 0,
  _onUrl: (url: string) => void = () => {}
): Promise<string> {
  const { streamVideo, videoStreamMime } = core.commands;
  if (typeof streamVideo !== 'function' || typeof videoStreamMime !== 'function') {
    throw new Error('no native video re-encoder');
  }

  const mime = streamMime ?? (await videoStreamMime());
  const chunks: Uint8Array[] = [];
  await streamVideo(source, nextStreamId++, (chunk) => {
    chunks.push(chunk);
  });
  if (chunks.length === 0) throw new Error('the re-encoder produced nothing');

  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }));
}
