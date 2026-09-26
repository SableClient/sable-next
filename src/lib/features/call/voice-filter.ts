import { DeepFilterNet3Core, DeepFilterNoiseFilterProcessor } from 'deepfilternet3-noise-filter';

const assetConfig = { cdnUrl: '/deepfilternet3' };
const SAMPLE_RATE = 48000;
const SUPPRESSION_LEVEL = 50;

type LoadedCore = {
  assets: { wasmModule: WebAssembly.Module; modelBytes: ArrayBuffer } | null;
};

export type VoiceFilterBank = {
  readonly context: AudioContext;
  create: () => Promise<AudioWorkletNode>;
  close: () => void;
};

export const supportsVoiceFilter = (): boolean =>
  DeepFilterNoiseFilterProcessor.isSupported() && typeof AudioWorkletNode !== 'undefined';

export const createMicrophoneFilter = (): DeepFilterNoiseFilterProcessor =>
  new DeepFilterNoiseFilterProcessor({ assetConfig });

export function createVoiceFilterBank(): VoiceFilterBank {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const core = new DeepFilterNet3Core({
    sampleRate: SAMPLE_RATE,
    noiseReductionLevel: SUPPRESSION_LEVEL,
    assetConfig,
  });
  let registered: Promise<AudioWorkletNode> | undefined;

  return {
    context,
    create: async () => {
      if (!registered) {
        registered = core.initialize().then(() => core.createAudioWorkletNode(context));
        return registered;
      }
      await registered;
      const { assets } = core as unknown as LoadedCore;
      if (!assets) throw new Error('DeepFilterNet3 assets are not loaded');
      return new AudioWorkletNode(context, 'deepfilter-audio-processor', {
        processorOptions: { ...assets, suppressionLevel: SUPPRESSION_LEVEL },
      });
    },
    close: () => {
      core.destroy();
      void context.close();
    },
  };
}
