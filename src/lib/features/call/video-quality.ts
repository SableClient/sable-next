import type {
  ScreenShareCaptureOptions,
  TrackPublishOptions,
  VideoCodec,
  VideoResolution,
} from 'livekit-client';

import { hardwareVideoEncoders, type ProbedVideoCodec } from '#lib/platform/video-encoders.js';

import type {
  CallScreenFramerate,
  CallVideoBitrate,
  CallVideoCodec,
  CallVideoResolution,
} from '#lib/settings/definitions.js';

export function videoResolution(value: CallVideoResolution): VideoResolution | undefined {
  if (value === 'auto') return undefined;
  const height = Number(value);
  return { width: Math.round((height * 16) / 9), height };
}

const SCREEN_DEFAULT_HEIGHT = 1080;
const SCREEN_DEFAULT_BITRATE_KBPS: Record<'15' | '30' | '60', number> = {
  '15': 3000,
  '30': 5000,
  '60': 8000,
};

function displayResolution(): VideoResolution {
  const aspect = screen.width / screen.height;
  const height = Math.min(screen.height * devicePixelRatio, SCREEN_DEFAULT_HEIGHT);
  return { width: Math.round(height * aspect), height: Math.round(height) };
}

const contentHint = 'motion';

export function screenCaptureOptions(
  resolution: CallVideoResolution,
  framerate: CallScreenFramerate
): ScreenShareCaptureOptions {
  const size = videoResolution(resolution);
  if (framerate === 'auto') return size ? { contentHint, resolution: size } : { contentHint };
  const frameRate = Number(framerate);
  return { contentHint, resolution: { ...(size ?? displayResolution()), frameRate } };
}

const AUTO_CODECS: readonly ProbedVideoCodec[] = ['h264', 'vp9', 'av1'];

export async function resolveVideoCodec(codec: CallVideoCodec): Promise<VideoCodec> {
  if (codec !== 'auto') return codec;
  const hardware = await hardwareVideoEncoders();
  return AUTO_CODECS.find((candidate) => hardware.includes(candidate)) ?? 'h264';
}

export function videoPublishOptions(
  source: 'camera' | 'screen',
  bitrate: CallVideoBitrate,
  codec: VideoCodec,
  simulcast: boolean,
  framerate: CallScreenFramerate = 'auto'
): TrackPublishOptions {
  const options: TrackPublishOptions = { videoCodec: codec };
  if (!simulcast) options.simulcast = false;
  if (bitrate !== 'auto') {
    const encoding = { maxBitrate: Number(bitrate) * 1000 };
    if (source === 'camera') options.videoEncoding = encoding;
    else options.screenShareEncoding = encoding;
    options.backupCodec = { codec: 'vp8', encoding };
  }
  if (source === 'screen' && framerate !== 'auto') {
    const maxBitrate =
      bitrate === 'auto' ? SCREEN_DEFAULT_BITRATE_KBPS[framerate] * 1000 : Number(bitrate) * 1000;
    options.screenShareEncoding = { maxBitrate, maxFramerate: Number(framerate) };
  }
  return options;
}
