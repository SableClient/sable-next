import { electronBridge } from './electron';
import type { ScreenAudioListing } from './screen-audio-types';
import { readJson, writeJson } from './local-json';
import {
  type ScreenAudioChoice,
  startScreenAudioStream,
  stopScreenAudioStream,
} from './screen-audio-stream';
import { sleep } from '#lib/sleep.js';

export const SCREEN_AUDIO_LABELS = ['Sable screen audio', 'vencord-screen-share'];

const CHOICE_KEY = 'sable-screen-audio-choice';
const DEVICE_ATTEMPTS = 20;
const DEVICE_POLL_MS = 100;

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

function parseChoice(value: unknown): ScreenAudioChoice {
  if (typeof value !== 'object' || value === null) return { kind: 'none' };
  const choice = value as Record<string, unknown>;
  const workaround = choice.workaround === true ? { workaround: true } : {};
  if (choice.kind === 'system')
    return { kind: 'system', exclude: names(choice.exclude), ...workaround };
  if (choice.kind === 'apps')
    return { kind: 'apps', include: names(choice.include), ...workaround };
  return { kind: 'none' };
}

export function lastScreenAudioChoice(): ScreenAudioChoice {
  const choice = readJson(CHOICE_KEY, parseChoice, { kind: 'none' });
  if (electronBridge()?.screenAudioAvailable && choice.kind === 'apps')
    return { kind: 'apps', include: choice.include.filter((id) => id.startsWith('audiofox:')) };
  return choice;
}

export function rememberScreenAudioChoice(choice: ScreenAudioChoice): void {
  writeJson(CHOICE_KEY, choice, '[sable call] screen audio choice not persisted');
}

export async function listScreenAudioApps(): Promise<ScreenAudioListing> {
  return electronBridge()?.screenAudioApps() ?? { status: 'unavailable', apps: [] };
}

export function screenAudioAppLabel(id: string): string {
  if (id.startsWith('audiofox:')) return id.slice('audiofox:'.length);
  if (!id.startsWith('pipewire:')) return id;
  try {
    const props = JSON.parse(id.slice('pipewire:'.length)) as Partial<Record<string, string>>;
    const name = props['application.name'] ?? props['node.name'] ?? id;
    const details = [props['media.name'], props['application.process.id']].filter(Boolean);
    return details.length ? `${name} (${details.join(' · ')})` : name;
  } catch {
    return id;
  }
}

export async function unmuteScreenAudio(): Promise<void> {
  await electronBridge()?.unmuteScreenAudio();
}

export function screenAudioSupported(): boolean {
  return electronBridge()?.screenAudioAvailable ?? false;
}

export function screenAudioPicksMany(): boolean {
  return electronBridge()?.screenAudioAvailable ?? false;
}

export function screenAudioSystemSupported(): boolean {
  return electronBridge()?.platform !== 'darwin';
}

export function screenAudioCanExclude(): boolean {
  return electronBridge()?.platform === 'linux';
}

async function findInput(label: string): Promise<MediaDeviceInfo | null> {
  for (let attempt = 0; attempt < DEVICE_ATTEMPTS; attempt += 1) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = devices.find(
      (candidate) => candidate.kind === 'audioinput' && candidate.label.includes(label)
    );
    if (device) return device;
    await sleep(DEVICE_POLL_MS);
  }
  return null;
}

export async function captureScreenAudio(
  selection: Exclude<ScreenAudioChoice, { kind: 'none' }>
): Promise<MediaStreamTrack> {
  const electron = electronBridge();
  if (!electron) throw new Error('screen audio unsupported');
  if (electron.platform === 'win32' || (electron.screenAudioAvailable && selection.kind === 'apps'))
    return startScreenAudioStream(selection);
  try {
    const label = await electron.startScreenAudio(selection);
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
    await stopScreenAudio().catch((cleanupError: unknown) => {
      console.warn('[sable screen audio] cleanup failed', cleanupError);
    });
    throw error;
  }
}

export async function stopScreenAudio(): Promise<void> {
  const electron = electronBridge();
  if (electron?.screenAudioAvailable) {
    try {
      await stopScreenAudioStream();
    } finally {
      await electron.stopScreenAudio();
    }
    return;
  }
  if (electron?.platform === 'win32') return stopScreenAudioStream();
  await electron?.stopScreenAudio();
}
