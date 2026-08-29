import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extensionForMimeType,
  isVoiceRecordingSupported,
  pickRecordingMimeType,
} from './voice-recorder-support';

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

  it('reports unsupported when MediaRecorder does not exist', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(isVoiceRecordingSupported()).toBe(false);
    expect(pickRecordingMimeType()).toBeNull();
  });

  it('picks the first candidate the browser reports as supported', () => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: {
        isTypeSupported: (type: string) => type === 'audio/webm',
      },
      configurable: true,
      writable: true,
    });
    expect(pickRecordingMimeType()).toBe('audio/webm');
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
