import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import { ignoreError } from './call-transport';
import { createVoiceFilterBank, type MicrophoneProcessing } from './voice-filter';

type Output = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };

export async function startInputMeter(
  deviceId: string,
  onLevel: (level: number) => void,
  playback?: MicrophoneProcessing & { outputDevice: string }
): Promise<(() => void) | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...playback?.constraints,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (error) {
    console.debug('[sable call] input meter could not open microphone', error);
    return null;
  }

  const bank = playback?.filter ? createVoiceFilterBank() : undefined;
  const context: Output = bank?.context ?? new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  let input: AudioNode = context.createMediaStreamSource(stream);
  let filter: RnnoiseWorkletNode | undefined;
  if (bank) {
    try {
      filter = await bank.create();
      input = input.connect(filter);
    } catch (error) {
      console.debug('[sable call] input meter could not load the voice filter', error);
      for (const track of stream.getTracks()) {
        void track.applyConstraints({ noiseSuppression: true }).catch(ignoreError);
      }
    }
  }
  input.connect(analyser);
  if (playback) {
    analyser.connect(context.destination);
    if (playback.outputDevice) context.setSinkId?.(playback.outputDevice).catch(ignoreError);
    void context.resume().catch(ignoreError);
  }

  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;

  const tick = (): void => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onLevel(Math.min(Math.sqrt(sum / samples.length) * 4, 1));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    filter?.destroy();
    void context.close();
  };
}
