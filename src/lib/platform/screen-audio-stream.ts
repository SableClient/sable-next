import { Channel, invoke } from '@tauri-apps/api/core';

import workletUrl from './screen-audio-worklet.js?url';

import type { ScreenAudioChoice } from './screen-audio';

const SAMPLE_RATE = 48_000;

let active: { stop: () => Promise<void> } | null = null;

export async function startScreenAudioStream(
  selection: Exclude<ScreenAudioChoice, { kind: 'none' }>
): Promise<MediaStreamTrack> {
  await stopScreenAudioStream();
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const frames = new Channel<ArrayBuffer>();
  const stop = async (): Promise<void> => {
    frames.onmessage = () => undefined;
    await context.close().catch(() => undefined);
    await invoke('stop_screen_audio');
  };
  active = { stop };

  try {
    await context.audioWorklet.addModule(workletUrl);
    const player = new AudioWorkletNode(context, 'sable-screen-audio-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    const destination = new MediaStreamAudioDestinationNode(context, {
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    player.connect(destination);
    frames.onmessage = (data) => {
      if (data.byteLength === 0) {
        if (active?.stop === stop) void stopScreenAudioStream();
        return;
      }
      try {
        const samples = new Float32Array(data);
        player.port.postMessage(samples, [samples.buffer]);
      } catch (error) {
        console.warn('[sable call] dropped a screen audio chunk', error);
      }
    };
    await context.resume();
    await invoke('start_screen_audio_stream', { selection, frames });
    const track = destination.stream.getAudioTracks().at(0);
    if (!track) throw new Error('screen audio stream gave no track');
    return track;
  } catch (error) {
    await stopScreenAudioStream();
    throw error;
  }
}

export async function stopScreenAudioStream(): Promise<void> {
  const current = active;
  active = null;
  await current?.stop();
}
