import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { measureAttachment } from '#lib/core/attachment-info.js';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('./voice-recorder-encoder', () => ({
  createOggRecorder: (stream: MediaStream) => {
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/ogg' });
    return {
      recorder,
      dispose: () => {
        if (recorder.state !== 'inactive') recorder.stop();
      },
    };
  },
}));

import VoiceRecorder from './VoiceRecorder.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  ['audio/ogg;codecs=opus', true],
  ['audio/ogg', true],
  ['audio/ogg', false],
])('sends Ogg voice metadata for %s (native: %s)', async (recordedMime, native) => {
  let now = 1000;
  const stopTrack = vi.fn();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    },
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      createAnalyser() {
        return { fftSize: 1024, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) };
      }
      close() {
        return Promise.resolve();
      }
    }
  );
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported(type: string) {
        return native && type === recordedMime;
      }
      mimeType = recordedMime;
      state = 'inactive';
      onstart: (() => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
        this.onstart?.();
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recording'], { type: recordedMime }) });
        this.onstop?.();
      }
    }
  );

  const onSend = vi.fn<(file: File) => void>();
  render(VoiceRecorder, { props: { onSend, onCancel: vi.fn() } });
  const send = screen.getByRole('button', { name: 'composer.voiceSend' });
  await vi.waitFor(() => expect(send).toBeEnabled());
  now += 1250;
  await fireEvent.click(send);

  expect(onSend).toHaveBeenCalledOnce();
  const [file] = onSend.mock.calls[0];
  expect(file.type).toBe('audio/ogg');
  expect(file.name).toBe('voice-message-2250.ogg');
  expect(file.size).toBeGreaterThan(0);
  const info = await measureAttachment(file);
  expect(info).toMatchObject({ voice: true, duration_ms: 1250, audio_metadata: null });
  expect(info?.waveform).toHaveLength(40);
  expect(stopTrack).toHaveBeenCalledOnce();
});

test('unmounting during microphone permission releases the stream when it arrives', async () => {
  let grantPermission: (stream: MediaStream) => void = () => {};
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  const getUserMedia = vi.fn().mockReturnValue(permission);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
  const onSend = vi.fn();
  const { unmount } = render(VoiceRecorder, { props: { onSend, onCancel: vi.fn() } });
  await vi.waitFor(() => {
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  unmount();

  const stopTrack = vi.fn();
  grantPermission({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  await vi.waitFor(() => {
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  expect(onSend).not.toHaveBeenCalled();
});
