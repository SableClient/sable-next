import type { TrackPublishOptions, VideoResolution } from 'livekit-client';

import type {
  CallVideoBitrate,
  CallVideoCodec,
  CallVideoResolution,
} from '#lib/settings/preferences.svelte.js';

export function videoResolution(value: CallVideoResolution): VideoResolution | undefined {
  if (value === 'auto') return undefined;
  const height = Number(value);
  return { width: Math.round((height * 16) / 9), height };
}

export function videoPublishOptions(
  source: 'camera' | 'screen',
  bitrate: CallVideoBitrate,
  codec: CallVideoCodec
): TrackPublishOptions {
  const options: TrackPublishOptions = {};
  if (codec !== 'auto') options.videoCodec = codec;
  if (bitrate !== 'auto') {
    const encoding = { maxBitrate: Number(bitrate) * 1000 };
    if (source === 'camera') options.videoEncoding = encoding;
    else options.screenShareEncoding = encoding;
    options.simulcast = false;
    options.backupCodec = { codec: 'vp8', encoding };
  }
  return options;
}
