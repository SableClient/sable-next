import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType, version as osVersion } from '@tauri-apps/plugin-os';

import { readJson, writeJson } from './local-json';
import { startScreenAudioStream, stopScreenAudioStream } from './screen-audio-stream';

export type ScreenAudioChoice =
  | { kind: 'none' }
  | { kind: 'system'; exclude: string[] }
  | { kind: 'apps'; include: string[] };

export const SCREEN_AUDIO_LABEL = 'Sable screen audio';

const WINDOWS_LOOPBACK_BUILD = 19041;
const CHOICE_KEY = 'sable-screen-audio-choice';
const DEVICE_ATTEMPTS = 20;
const DEVICE_POLL_MS = 100;

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

function parseChoice(value: unknown): ScreenAudioChoice {
  if (typeof value !== 'object' || value === null) return { kind: 'none' };
  const choice = value as Record<string, unknown>;
  if (choice.kind === 'system') return { kind: 'system', exclude: names(choice.exclude) };
  if (choice.kind === 'apps') return { kind: 'apps', include: names(choice.include) };
  return { kind: 'none' };
}

export function lastScreenAudioChoice(): ScreenAudioChoice {
  return readJson(CHOICE_KEY, parseChoice, { kind: 'none' });
}

export function rememberScreenAudioChoice(choice: ScreenAudioChoice): void {
  writeJson(CHOICE_KEY, choice, '[sable call] screen audio choice not persisted');
}

export function listScreenAudioApps(): Promise<string[]> {
  return invoke<string[]>('screen_audio_apps');
}

function windowsBuild(): number {
  return Number(osVersion().split('.').at(2));
}

export function screenAudioSupported(): boolean {
  if (!isTauri()) return false;
  const os = osType();
  return os === 'linux' || (os === 'windows' && windowsBuild() >= WINDOWS_LOOPBACK_BUILD);
}

export function screenAudioPicksMany(): boolean {
  return osType() === 'linux';
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

export async function captureScreenAudio(
  selection: Exclude<ScreenAudioChoice, { kind: 'none' }>
): Promise<MediaStreamTrack> {
  if (osType() === 'windows') return startScreenAudioStream(selection);
  const label = await invoke<string>('start_screen_audio', { selection });
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
  return osType() === 'windows' ? stopScreenAudioStream() : invoke('stop_screen_audio');
}
