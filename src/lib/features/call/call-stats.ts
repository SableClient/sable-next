export type VideoStats = {
  direction: 'send' | 'receive';
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  implementation?: string;
  powerEfficient?: boolean;
  bitrate?: number;
};

export type VideoStatsSample = { bytes: number; timestamp: number };

type RtpStats = {
  type: 'outbound-rtp' | 'inbound-rtp';
  kind?: string;
  codecId?: string;
  timestamp: number;
  bytesSent?: number;
  bytesReceived?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  encoderImplementation?: string;
  decoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  powerEfficientDecoder?: boolean;
};

function isVideoRtp(entry: { type: string; kind?: string }): entry is RtpStats {
  return (entry.type === 'outbound-rtp' || entry.type === 'inbound-rtp') && entry.kind === 'video';
}

const area = (entry: RtpStats): number => (entry.frameWidth ?? 0) * (entry.frameHeight ?? 0);

export const BITRATE_WINDOW_MS = 5000;

export function readVideoStats(
  report: RTCStatsReport
): { stats: VideoStats; sample: VideoStatsSample } | undefined {
  const streams: RtpStats[] = [];
  report.forEach((entry: { type: string; kind?: string }) => {
    if (isVideoRtp(entry)) streams.push(entry);
  });
  if (streams.length === 0) return undefined;

  const main = streams.reduce((best, entry) => (area(entry) > area(best) ? entry : best));
  const send = main.type === 'outbound-rtp';
  const bytes = streams.reduce(
    (total, entry) => total + ((send ? entry.bytesSent : entry.bytesReceived) ?? 0),
    0
  );
  const sample = { bytes, timestamp: main.timestamp };
  const codec = main.codecId
    ? (report.get(main.codecId) as { mimeType?: string } | undefined)
    : undefined;

  return {
    stats: {
      direction: send ? 'send' : 'receive',
      width: main.frameWidth,
      height: main.frameHeight,
      fps: main.framesPerSecond,
      codec: codec?.mimeType?.replace(/^video\//i, ''),
      implementation: send ? main.encoderImplementation : main.decoderImplementation,
      powerEfficient: send ? main.powerEfficientEncoder : main.powerEfficientDecoder,
    },
    sample,
  };
}

export function bitrateWindow(
  window: readonly VideoStatsSample[],
  sample: VideoStatsSample
): VideoStatsSample[] {
  const last = window.at(-1);
  if (last && sample.timestamp <= last.timestamp) return [...window];
  if (last && sample.bytes < last.bytes) return [sample];
  return [
    ...window.filter((kept) => sample.timestamp - kept.timestamp <= BITRATE_WINDOW_MS),
    sample,
  ];
}

export function averageBitrate(window: readonly VideoStatsSample[]): number | undefined {
  const first = window.at(0);
  const last = window.at(-1);
  if (!first || !last || last.timestamp <= first.timestamp) return undefined;
  return ((last.bytes - first.bytes) * 8 * 1000) / (last.timestamp - first.timestamp);
}
