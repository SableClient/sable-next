import { afterEach, describe, expect, it, vi } from 'vitest';

import { screenCaptureOptions } from './video-quality.js';

async function resolveWith(hardware: string[], codec: 'auto' | 'vp8') {
  vi.resetModules();
  vi.stubGlobal('navigator', {
    mediaCapabilities: {
      encodingInfo: ({ video }: { video: { contentType: string } }) => {
        const codecName = video.contentType.replace('video/', '').toLowerCase();
        const powerEfficient = hardware.includes(codecName);
        return Promise.resolve({ supported: true, powerEfficient, smooth: true });
      },
    },
  });
  const { resolveVideoCodec } = await import('./video-quality.js');
  return resolveVideoCodec(codec);
}

describe('screenCaptureOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the display aspect ratio when only the framerate is set', () => {
    vi.stubGlobal('screen', { width: 1920, height: 1200 });
    vi.stubGlobal('devicePixelRatio', 1);
    expect(screenCaptureOptions('auto', '30').resolution).toEqual({
      width: 1728,
      height: 1080,
      frameRate: 30,
    });
  });

  it('passes an explicit size with the framerate', () => {
    expect(screenCaptureOptions('720', '60')).toEqual({
      contentHint: 'motion',
      resolution: { width: 1280, height: 720, frameRate: 60 },
    });
  });

  it('only hints at motion when both are automatic', () => {
    expect(screenCaptureOptions('auto', 'auto')).toEqual({ contentHint: 'motion' });
  });
});

describe('resolveVideoCodec', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks the first hardware encoder for auto', async () => {
    expect(await resolveWith(['vp8', 'av1', 'vp9'], 'auto')).toBe('vp9');
  });

  it('falls back to h264 when auto finds no hardware encoder', async () => {
    expect(await resolveWith(['vp8'], 'auto')).toBe('h264');
  });

  it('keeps an explicit codec', async () => {
    expect(await resolveWith(['h264'], 'vp8')).toBe('vp8');
  });
});
