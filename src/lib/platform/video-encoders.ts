import { electronBridge } from './electron.js';

const PROBED_CODECS = ['h264', 'vp9', 'av1', 'vp8'] as const;

export type ProbedVideoCodec = (typeof PROBED_CODECS)[number];

async function encodesInHardware(codec: ProbedVideoCodec): Promise<boolean> {
  const info = await navigator.mediaCapabilities.encodingInfo({
    type: 'webrtc',
    video: {
      contentType: `video/${codec.toUpperCase()}`,
      width: 1920,
      height: 1080,
      bitrate: 5_000_000,
      framerate: 30,
    },
  });
  return info.supported && info.powerEfficient;
}

let probe: Promise<ProbedVideoCodec[]> | undefined;

export function hardwareVideoEncoders(): Promise<ProbedVideoCodec[]> {
  probe ??= (async () => {
    const results = await Promise.all(
      PROBED_CODECS.map((codec) =>
        encodesInHardware(codec).catch((error: unknown) => {
          console.debug('[sable calls] encoder probe failed', codec, error);
          return false;
        })
      )
    );
    return PROBED_CODECS.filter((_, index) => results[index]);
  })();
  return probe;
}

export async function describeVideoAcceleration(): Promise<string> {
  const [encoders, gpu] = await Promise.all([
    hardwareVideoEncoders(),
    electronBridge()?.gpuVideoStatus(),
  ]);
  const parts = [`hardware encoders: ${encoders.join(', ') || 'none'}`];
  if (gpu) parts.push(`GPU video encode: ${gpu.encode}, decode: ${gpu.decode}`);
  return parts.join(' · ');
}
