import { describe, expect, it } from 'vitest';

import { averageBitrate, bitrateWindow, BITRATE_WINDOW_MS, readVideoStats } from './call-stats';

const report = (...entries: Record<string, unknown>[]): RTCStatsReport =>
  new Map(entries.map((entry) => [entry.id as string, entry]));

describe('readVideoStats', () => {
  it('reads a sent share from its largest layer and sums every layer for the byte count', () => {
    const first = readVideoStats(
      report(
        { id: 'c1', type: 'codec', mimeType: 'video/AV1' },
        {
          id: 'o1',
          type: 'outbound-rtp',
          kind: 'video',
          codecId: 'c1',
          timestamp: 1000,
          bytesSent: 1000,
          frameWidth: 960,
          frameHeight: 540,
          framesPerSecond: 15,
        },
        {
          id: 'o2',
          type: 'outbound-rtp',
          kind: 'video',
          codecId: 'c1',
          timestamp: 1000,
          bytesSent: 4000,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 30,
          encoderImplementation: 'ExternalEncoder',
          powerEfficientEncoder: true,
        }
      )
    );
    expect(first?.stats).toEqual({
      direction: 'send',
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'AV1',
      implementation: 'ExternalEncoder',
      powerEfficient: true,
    });
    expect(first?.sample).toEqual({ bytes: 5000, timestamp: 1000 });
  });

  it('reads a received share with its decoder', () => {
    const read = readVideoStats(
      report(
        { id: 'c', type: 'codec', mimeType: 'video/VP9' },
        { id: 'a', type: 'inbound-rtp', kind: 'audio', timestamp: 1, bytesReceived: 9 },
        {
          id: 'v',
          type: 'inbound-rtp',
          kind: 'video',
          codecId: 'c',
          timestamp: 1,
          bytesReceived: 10,
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 59.9,
          decoderImplementation: 'libvpx',
          powerEfficientDecoder: false,
        }
      )
    );
    expect(read?.stats).toMatchObject({
      direction: 'receive',
      width: 1280,
      height: 720,
      fps: 59.9,
      codec: 'VP9',
      implementation: 'libvpx',
      powerEfficient: false,
    });
    expect(read?.sample).toEqual({ bytes: 10, timestamp: 1 });
  });

  it('has nothing to say without a video stream', () => {
    expect(readVideoStats(report({ id: 'x', type: 'transport', timestamp: 1 }))).toBeUndefined();
  });
});

describe('averageBitrate', () => {
  it('averages over the window and waits for a second sample', () => {
    let window = bitrateWindow([], { bytes: 0, timestamp: 0 });
    expect(averageBitrate(window)).toBeUndefined();
    window = bitrateWindow(window, { bytes: 1_000_000, timestamp: 1000 });
    window = bitrateWindow(window, { bytes: 1_250_000, timestamp: 2000 });
    expect(averageBitrate(window)).toBe(5_000_000);
  });

  it('forgets samples older than the window', () => {
    let window = bitrateWindow([], { bytes: 0, timestamp: 0 });
    window = bitrateWindow(window, { bytes: 1_000_000, timestamp: BITRATE_WINDOW_MS });
    window = bitrateWindow(window, { bytes: 1_125_000, timestamp: BITRATE_WINDOW_MS + 1000 });
    expect(window[0]?.timestamp).toBe(BITRATE_WINDOW_MS);
    expect(averageBitrate(window)).toBe(1_000_000);
  });

  it('starts over when the byte count goes backwards', () => {
    const window = bitrateWindow([{ bytes: 100, timestamp: 1000 }], { bytes: 5, timestamp: 2000 });
    expect(window).toEqual([{ bytes: 5, timestamp: 2000 }]);
    expect(averageBitrate(window)).toBeUndefined();
  });

  it('ignores a report that is not newer', () => {
    const window = [{ bytes: 100, timestamp: 1000 }];
    expect(bitrateWindow(window, { bytes: 100, timestamp: 1000 })).toEqual(window);
  });
});
