import type { CallRingtoneVolume } from '#lib/settings/preferences.svelte.js';

import { ignoreError } from './call-transport';

const RING_HZ = [440, 480];
const BURST_MS = 1200;
const GAP_MS = 2400;

export type Ringtone = { stop: () => void };

const PEAK_GAIN = 0.12;

const VOLUMES: Record<CallRingtoneVolume, number> = { quiet: 0.35, normal: 1, loud: 2 };

export function ringtoneVolume(setting: CallRingtoneVolume): number {
  return VOLUMES[setting];
}

export function startRingtone(volume = 1): Ringtone {
  const scope = globalThis as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextClass = scope.AudioContext ?? scope.webkitAudioContext;
  if (!AudioContextClass) return { stop: () => {} };

  let context: AudioContext;
  try {
    context = new AudioContextClass();
  } catch {
    return { stop: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const burst = (): void => {
    if (stopped) return;

    const peak = Math.max(0.0002, PEAK_GAIN * volume);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(peak, context.currentTime + 0.05);
    gain.gain.setValueAtTime(peak, context.currentTime + BURST_MS / 1000 - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + BURST_MS / 1000);
    gain.connect(context.destination);

    for (const frequency of RING_HZ) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(context.currentTime + BURST_MS / 1000);
    }

    timer = setTimeout(burst, BURST_MS + GAP_MS);
  };

  void context.resume().then(burst, ignoreError);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      void context.close().catch(ignoreError);
    },
  };
}
