import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

const DEVICE_ATTEMPTS = 20;
const DEVICE_POLL_MS = 100;

export function screenAudioSupported(): boolean {
  return isTauri() && osType() === 'linux';
}

async function findInput(label: string): Promise<MediaDeviceInfo | null> {
  for (let attempt = 0; attempt < DEVICE_ATTEMPTS; attempt += 1) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = devices.find(
      (candidate) => candidate.kind === 'audioinput' && candidate.label.includes(label)
    );
    if (device) return device;
    await new Promise((resolve) => setTimeout(resolve, DEVICE_POLL_MS));
  }
  return null;
}

export async function captureScreenAudio(): Promise<MediaStreamTrack> {
  const label = await invoke<string>('start_screen_audio');
  try {
    const device = await findInput(label);
    if (!device) throw new Error('screen audio source did not appear');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const track = stream.getAudioTracks().at(0);
    if (!track) throw new Error('screen audio source gave no track');
    return track;
  } catch (error) {
    await stopScreenAudio();
    throw error;
  }
}

export function stopScreenAudio(): Promise<void> {
  return invoke('stop_screen_audio');
}
