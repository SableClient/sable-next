import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extensionForMimeType,
  isVoiceRecordingSupported,
  loadVoiceRecorder,
  pickRecordingMimeType,
} from './voice-recorder-support';

vi.mock('./voice-recorder-encoder', () => ({ createOggRecorder: vi.fn() }));

import { createOggRecorder } from './voice-recorder-encoder';

describe('extensionForMimeType', () => {
  it('maps known containers to their extension', () => {
    expect(extensionForMimeType('audio/ogg;codecs=opus')).toBe('ogg');
    expect(extensionForMimeType('audio/webm')).toBe('webm');
    expect(extensionForMimeType('audio/mp4')).toBe('m4a');
    expect(extensionForMimeType('audio/mpeg')).toBe('mp3');
    expect(extensionForMimeType('audio/wav')).toBe('wav');
    expect(extensionForMimeType('audio/aac')).toBe('aac');
  });

  it('falls back to webm for an unknown container', () => {
    expect(extensionForMimeType('audio/x-mystery')).toBe('webm');
  });
});

describe('pickRecordingMimeType and isVoiceRecordingSupported', () => {
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: originalMediaRecorder,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it('has no native recording type when MediaRecorder does not exist', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(pickRecordingMimeType()).toBeNull();
  });

  it('picks the first candidate the browser reports as supported', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: {
        isTypeSupported: (type: string) => type === 'audio/ogg;codecs=opus',
      },
      configurable: true,
      writable: true,
    });
    expect(pickRecordingMimeType()).toBe('audio/ogg;codecs=opus');
  });

  it('uses the Ogg encoder when only WebM and MP4 are supported natively', async () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => ['audio/webm;codecs=opus', 'audio/mp4'].includes(type),
    });
    expect(pickRecordingMimeType()).toBeNull();
    expect(await loadVoiceRecorder()).toBe(createOggRecorder);
  });

  it('uses the Ogg encoder when there is no native MediaRecorder', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(await loadVoiceRecorder()).toBe(createOggRecorder);
  });

  it('supports recording through the encoder without a native MediaRecorder', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.stubGlobal('AudioContext', vi.fn());
    vi.stubGlobal('Worker', vi.fn());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    expect(isVoiceRecordingSupported()).toBe(true);
  });

  it('returns null when nothing on the candidate list is supported', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: {
        isTypeSupported: () => false,
      },
      configurable: true,
      writable: true,
    });
    expect(pickRecordingMimeType()).toBeNull();
  });

  it('requires getUserMedia on navigator.mediaDevices', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: {
        isTypeSupported: () => true,
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: {} },
      configurable: true,
      writable: true,
    });
    expect(isVoiceRecordingSupported()).toBe(false);
  });
});
