// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(() =>
    Promise.resolve(undefined)
  ),
  isTauri: vi.fn(() => true),
}));
vi.mock('@tauri-apps/api/core', () => tauri);

const os = vi.hoisted(() => ({
  type: vi.fn<() => string>(() => 'windows'),
  version: vi.fn<() => string>(() => '10.0.22631'),
}));
vi.mock('@tauri-apps/plugin-os', () => os);

const stream = vi.hoisted(() => ({
  startScreenAudioStream: vi.fn(() => Promise.resolve({} as MediaStreamTrack)),
  stopScreenAudioStream: vi.fn(() => Promise.resolve()),
}));
vi.mock('./screen-audio-stream', () => stream);

import {
  captureScreenAudio,
  screenAudioPicksMany,
  screenAudioSupported,
  stopScreenAudio,
} from './screen-audio';

beforeEach(() => {
  tauri.invoke.mockClear();
  stream.startScreenAudioStream.mockClear();
  stream.stopScreenAudioStream.mockClear();
  tauri.isTauri.mockReturnValue(true);
  os.type.mockReturnValue('windows');
  os.version.mockReturnValue('10.0.22631');
});

test('Windows shares per-application audio from Windows 10 2004', () => {
  expect(screenAudioSupported()).toBe(true);
  os.version.mockReturnValue('10.0.19041');
  expect(screenAudioSupported()).toBe(true);
  os.version.mockReturnValue('10.0.18363');
  expect(screenAudioSupported()).toBe(false);
});

test('Linux is supported whatever the kernel version, and macOS and the web are not', () => {
  os.type.mockReturnValue('linux');
  os.version.mockReturnValue('6.12.0');
  expect(screenAudioSupported()).toBe(true);
  os.type.mockReturnValue('macos');
  expect(screenAudioSupported()).toBe(false);
  os.type.mockReturnValue('windows');
  tauri.isTauri.mockReturnValue(false);
  expect(screenAudioSupported()).toBe(false);
});

test('only Linux lets several apps be picked', () => {
  expect(screenAudioPicksMany()).toBe(false);
  os.type.mockReturnValue('linux');
  expect(screenAudioPicksMany()).toBe(true);
});

test('Windows captures through the PCM stream, not a virtual device', async () => {
  await captureScreenAudio({ kind: 'system', exclude: [] });
  expect(stream.startScreenAudioStream).toHaveBeenCalledWith({ kind: 'system', exclude: [] });
  expect(tauri.invoke).not.toHaveBeenCalled();

  await stopScreenAudio();
  expect(stream.stopScreenAudioStream).toHaveBeenCalled();
});

test('Linux stops through the native command', async () => {
  os.type.mockReturnValue('linux');
  await stopScreenAudio();
  expect(tauri.invoke).toHaveBeenCalledWith('stop_screen_audio');
  expect(stream.stopScreenAudioStream).not.toHaveBeenCalled();
});
