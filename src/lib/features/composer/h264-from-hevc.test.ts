import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { h264FromHevc, isHevcVideo } from './h264-from-hevc';

const ios = vi.hoisted(() => ({ value: true }));
const rawInvoke = vi.hoisted(() => vi.fn());
vi.mock('#lib/platform/os.js', () => ({ isIos: () => ios.value }));
vi.mock('#lib/platform/raw-invoke.js', () => ({ rawInvoke }));

const fixture = (name: string) =>
  new File([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))], name);

describe('isHevcVideo', () => {
  it('reads the codec of the video track', async () => {
    expect(await isHevcVideo(fixture('hevc.mov'))).toBe(true);
    expect(await isHevcVideo(fixture('h264.mp4'))).toBe(false);
    expect(await isHevcVideo(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png'))).toBe(
      false
    );
  });
});

describe('h264FromHevc', () => {
  afterEach(() => {
    ios.value = true;
    rawInvoke.mockReset();
  });

  it('re-encodes hevc on iOS as an mp4', async () => {
    rawInvoke.mockResolvedValue(new Uint8Array([7, 7]).buffer);
    const result = await h264FromHevc(fixture('hevc.mov'));
    expect(rawInvoke).toHaveBeenCalledWith('h264_from_hevc', expect.any(Uint8Array), {});
    expect(result.name).toBe('hevc.mp4');
    expect(result.type).toBe('video/mp4');
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
  });

  it('keeps h264 videos and other platforms untouched', async () => {
    const h264 = fixture('h264.mp4');
    expect(await h264FromHevc(h264)).toBe(h264);
    ios.value = false;
    const hevc = fixture('hevc.mov');
    expect(await h264FromHevc(hevc)).toBe(hevc);
    expect(rawInvoke).not.toHaveBeenCalled();
  });

  it('sends the original when the export fails', async () => {
    rawInvoke.mockRejectedValue(new Error('export failed'));
    const hevc = fixture('hevc.mov');
    expect(await h264FromHevc(hevc)).toBe(hevc);
  });
});
