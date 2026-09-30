import OpusRecorder from 'opus-recorder';
import encoderUrl from 'opus-recorder/dist/encoderWorker.min.js?url';

import type { VoiceMediaRecorder, VoiceRecordingSession } from './voice-recorder-support';

export function createOggRecorder(
  stream: MediaStream,
  context: AudioContext
): VoiceRecordingSession {
  const encoder = new OpusRecorder({
    encoderPath: encoderUrl,
    sourceNode: context.createMediaStreamSource(stream),
    numberOfChannels: 1,
    encoderApplication: 2048,
    encoderBitRate: 32_000,
    encoderSampleRate: 48_000,
  });
  let disposed = false;
  const recorder: VoiceMediaRecorder = {
    mimeType: 'audio/ogg',
    state: 'inactive',
    onstart: null,
    onstop: null,
    onerror: null,
    ondataavailable: null,
    start: () => {
      void encoder
        .start()
        .catch(() => {
          recorder.state = 'inactive';
          recorder.onerror?.(new ErrorEvent('error'));
        })
        .finally(() => {
          if (disposed) void encoder.close();
        });
    },
    stop: () => {
      recorder.state = 'inactive';
      void encoder.stop();
    },
  };
  encoder.onstart = () => {
    if (disposed) return;
    recorder.state = 'recording';
    recorder.onstart?.(new Event('start'));
  };
  encoder.ondataavailable = (bytes) => {
    const data = new Blob([bytes.slice()], { type: recorder.mimeType });
    recorder.ondataavailable?.(Object.assign(new Event('dataavailable'), { data, timecode: 0 }));
  };
  encoder.onstop = () => {
    recorder.onstop?.(new Event('stop'));
  };
  return {
    recorder,
    dispose: () => {
      disposed = true;
      void encoder.close();
    },
  };
}
