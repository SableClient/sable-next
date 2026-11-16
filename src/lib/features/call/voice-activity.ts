import { ignoreError } from './call-transport';

export const SPEAKING_LEVEL = 0.08;
export const SPEAKING_ATTACK_MS = 60;
export const SPEAKING_RELEASE_MS = 300;
const POLL_MS = 20;

export const levelOf = (samples: Float32Array): number => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(Math.sqrt(sum / samples.length) * 4, 1);
};

export function voiceGate(): (level: number, now: number) => boolean {
  let speaking = false;
  let since: number | undefined;
  return (level, now) => {
    if (level > SPEAKING_LEVEL === speaking) {
      since = undefined;
      return speaking;
    }
    since ??= now;
    if (now - since >= (speaking ? SPEAKING_RELEASE_MS : SPEAKING_ATTACK_MS)) {
      speaking = !speaking;
      since = undefined;
    }
    return speaking;
  };
}

type Source = { readonly mediaStreamTrack: MediaStreamTrack };

type Watch = {
  source: Source;
  input?: MediaStreamTrack;
  node?: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  gate: (level: number, now: number) => boolean;
  speaking: boolean;
  heard: boolean;
};

export type VoiceActivity = {
  watch: (identity: string, source: Source) => void;
  unwatch: (identity: string) => void;
  speaking: (identity: string) => boolean | undefined;
  dispose: () => void;
};

export function createVoiceActivity(onChange: () => void): VoiceActivity {
  let context: AudioContext | undefined;
  const watched = new Map<string, Watch>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const connect = (watch: Watch): void => {
    const input = watch.source.mediaStreamTrack;
    if (watch.input === input || !context) return;
    watch.node?.disconnect();
    watch.input = input;
    watch.node = context.createMediaStreamSource(new MediaStream([input]));
    watch.node.connect(watch.analyser);
  };

  const poll = (): void => {
    const now = performance.now();
    let changed = false;
    for (const watch of watched.values()) {
      connect(watch);
      watch.analyser.getFloatTimeDomainData(watch.samples);
      const level = levelOf(watch.samples);
      if (level > 0) watch.heard = true;
      const speaking = watch.gate(level, now);
      if (speaking !== watch.speaking) {
        watch.speaking = speaking;
        changed = true;
      }
    }
    if (changed) onChange();
  };

  const unwatch = (identity: string): void => {
    const watch = watched.get(identity);
    if (!watch) return;
    watched.delete(identity);
    watch.node?.disconnect();
    if (watched.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    watch: (identity, source) => {
      if (typeof AudioContext === 'undefined') return;
      if (watched.get(identity)?.source === source) return;
      unwatch(identity);
      context ??= new AudioContext();
      if (context.state === 'suspended') void context.resume().catch(ignoreError);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const watch: Watch = {
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        gate: voiceGate(),
        speaking: false,
        heard: false,
      };
      try {
        connect(watch);
      } catch (error) {
        console.debug('[sable call] voice activity could not watch a track', error);
        return;
      }
      watched.set(identity, watch);
      timer ??= setInterval(poll, POLL_MS);
    },
    unwatch,
    // Some engines never feed remote WebRTC audio to Web Audio.
    speaking: (identity) => {
      const watch = watched.get(identity);
      return watch?.heard ? watch.speaking : undefined;
    },
    dispose: () => {
      for (const identity of [...watched.keys()]) unwatch(identity);
      void context?.close().catch(ignoreError);
      context = undefined;
    },
  };
}
