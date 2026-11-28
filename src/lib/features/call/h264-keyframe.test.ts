import { describe, expect, test } from 'vitest';

import { reorderKeyframe } from './h264-keyframe';

const idr = [0, 0, 0, 1, 0x65, 0xaa, 0xbb];
const sps = [0, 0, 0, 1, 0x67, 0x42, 0x00];
const pps = [0, 0, 1, 0x68, 0xce];

describe('reorderKeyframe', () => {
  test('moves SPS and PPS ahead of the IDR slice', () => {
    const fixed = reorderKeyframe(Uint8Array.from([...idr, ...sps, ...pps]));
    expect(fixed && [...fixed]).toEqual([...sps, ...pps, ...idr]);
  });

  test('leaves a keyframe that already starts with SPS and PPS', () => {
    expect(reorderKeyframe(Uint8Array.from([...sps, ...pps, ...idr]))).toBeNull();
  });

  test('leaves a keyframe with extra NAL units', () => {
    expect(reorderKeyframe(Uint8Array.from([...idr, ...idr, ...sps, ...pps]))).toBeNull();
  });
});
