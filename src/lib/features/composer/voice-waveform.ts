export const WAVEFORM_BUCKETS = 40;

export function downsampleWaveform(
  samples: readonly number[],
  buckets: number = WAVEFORM_BUCKETS
): number[] {
  if (buckets <= 0) return [];
  if (samples.length === 0) return Array.from({ length: buckets }, () => 0);

  const bucketed: number[] = [];
  for (let index = 0; index < buckets; index++) {
    const start = Math.floor((index * samples.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / buckets));
    let sum = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
      sum += samples[sampleIndex];
    }
    bucketed.push(sum / (end - start));
  }

  const max = Math.max(...bucketed, 0);
  if (max === 0) return bucketed.map(() => 0);
  return bucketed.map((value) => Math.min(1, Math.max(0, value / max)));
}
