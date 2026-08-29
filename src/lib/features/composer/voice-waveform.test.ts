import { describe, expect, it } from 'vitest';

import { downsampleWaveform, WAVEFORM_BUCKETS } from './voice-waveform';

describe('downsampleWaveform', () => {
  it('returns the requested number of buckets', () => {
    const result = downsampleWaveform([0.1, 0.2, 0.3, 0.4, 0.5], 5);
    expect(result).toHaveLength(5);
  });

  it('defaults to WAVEFORM_BUCKETS buckets', () => {
    const result = downsampleWaveform([0.1, 0.2, 0.3]);
    expect(result).toHaveLength(WAVEFORM_BUCKETS);
  });

  it('returns all zeros for an empty input', () => {
    const result = downsampleWaveform([], 8);
    expect(result).toEqual(Array.from({ length: 8 }, () => 0));
  });

  it('normalises so the loudest bucket is 1', () => {
    const result = downsampleWaveform([0, 0.5, 1, 0.5, 0], 5);
    expect(Math.max(...result)).toBeCloseTo(1);
  });

  it('never returns a value outside 0..1', () => {
    const result = downsampleWaveform([2, 5, 10, 3, 8, 1, 9], 4);
    for (const value of result) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('averages samples within a bucket rather than picking one', () => {
    const result = downsampleWaveform([0, 1], 1);
    expect(result).toEqual([1]);
  });

  it('is stable when every sample is silent', () => {
    const result = downsampleWaveform([0, 0, 0, 0], 4);
    expect(result).toEqual([0, 0, 0, 0]);
  });

  it('upsamples a shorter input by repeating buckets', () => {
    const result = downsampleWaveform([1], 3);
    expect(result).toEqual([1, 1, 1]);
  });
});
