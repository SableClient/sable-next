import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { ignoreError } from './call-transport';

const SAMPLE_RATE = 48000;

async function loadFilter() {
  // The package defines AudioWorkletNode subclasses at module scope.
  const { RnnoiseWorkletNode, loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
  const wasmBinary = await loadRnnoise({ url: wasmUrl, simdUrl });
  return { RnnoiseWorkletNode, wasmBinary };
}

let loaded: ReturnType<typeof loadFilter> | undefined;

function loadAssets() {
  return (loaded ??= loadFilter().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  }));
}

export type VoiceFilterBank = {
  readonly context: AudioContext;
  create: () => Promise<RnnoiseWorkletNode>;
  close: () => void;
};

export const supportsVoiceFilter = (): boolean =>
  typeof AudioContext !== 'undefined' &&
  typeof AudioWorkletNode !== 'undefined' &&
  typeof WebAssembly !== 'undefined';

export function microphoneProcessing() {
  const voiceIsolation = preferences.noiseSuppression && preferences.voiceIsolation;
  const filter = voiceIsolation && supportsVoiceFilter();
  return {
    filter,
    constraints: {
      echoCancellation: preferences.echoCancellation,
      noiseSuppression: preferences.noiseSuppression && !filter,
      autoGainControl: preferences.autoGainControl,
      ...(voiceIsolation && !filter ? { voiceIsolation: true } : {}),
    },
  };
}

export type MicrophoneProcessing = ReturnType<typeof microphoneProcessing>;

export function createVoiceFilterBank(): VoiceFilterBank {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let ready: ReturnType<typeof loadFilter> | undefined;

  return {
    context,
    create: async () => {
      const { RnnoiseWorkletNode, wasmBinary } = await (ready ??= Promise.all([
        loadAssets(),
        context.audioWorklet.addModule(workletUrl),
      ]).then(([assets]) => assets));
      if (context.state === 'closed') throw new Error('Voice filter bank is closed');
      const filter = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
      filter.channelCount = 1;
      filter.channelCountMode = 'explicit';
      return filter;
    },
    close: () => {
      void context.close().catch(ignoreError);
    },
  };
}

export function createMicrophoneFilter(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let bank: VoiceFilterBank | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let filter: RnnoiseWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;

  const cleanup = (): void => {
    source?.disconnect();
    filter?.destroy();
    filter?.disconnect();
    destination?.stream.getTracks().forEach((track) => {
      track.stop();
    });
    bank?.close();
    bank = undefined;
    source = undefined;
    filter = undefined;
    destination = undefined;
    processor.processedTrack = undefined;
  };

  const init = async ({ track }: AudioProcessorOptions): Promise<void> => {
    cleanup();
    const currentBank = createVoiceFilterBank();
    bank = currentBank;
    try {
      const node = await currentBank.create();
      if (bank !== currentBank) {
        node.destroy();
        node.disconnect();
        return;
      }
      filter = node;
      destination = currentBank.context.createMediaStreamDestination();
      source = currentBank.context.createMediaStreamSource(new MediaStream([track]));
      source.connect(filter).connect(destination);
      await currentBank.context.resume();
      if (bank === currentBank) processor.processedTrack = destination.stream.getAudioTracks()[0];
    } catch (error) {
      if (bank === currentBank) cleanup();
      throw error;
    }
  };

  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'rnnoise',
    init,
    restart: init,
    destroy: () => {
      cleanup();
      return Promise.resolve();
    },
  };
  return processor;
}
