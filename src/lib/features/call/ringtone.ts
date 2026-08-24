import { ignoreError } from './call-transport';

const RING_HZ = [440, 480];
const BURST_MS = 1200;
const GAP_MS = 2400;

export type Ringtone = { stop: () => void };

export function startRingtone(): Ringtone {
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

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.05);
    gain.gain.setValueAtTime(0.12, context.currentTime + BURST_MS / 1000 - 0.05);
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
