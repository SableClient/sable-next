// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { RoomEvent, type Room } from 'livekit-client';

import CallPlayback from './CallPlayback.svelte';
import type { CallTelemetry } from './call-telemetry';
import type { CallTransportRoom } from './call-transport';

type FakeRoom = {
  room: Room;
  emit: () => void;
  setPlaybackAllowed: (allowed: boolean) => void;
  startAudio: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

type TelemetryStub = Pick<CallTelemetry, 'event' | 'failure' | 'step'> & {
  step: ReturnType<typeof vi.fn>;
  failure: ReturnType<typeof vi.fn>;
};

function fakeRoom(allowed: boolean): FakeRoom {
  const listeners = new Set<() => void>();
  let playbackAllowed = allowed;
  const startAudio = vi.fn(() => {
    playbackAllowed = true;
    return Promise.resolve();
  });
  const off = vi.fn((_event: RoomEvent, listener: () => void) => {
    listeners.delete(listener);
    return room;
  });
  const room = {
    get canPlaybackAudio() {
      return playbackAllowed;
    },
    startAudio,
    on: vi.fn((_event: RoomEvent, listener: () => void) => {
      listeners.add(listener);
      return room;
    }),
    off,
  } as unknown as Room;
  return {
    room,
    emit: () => {
      listeners.forEach((listener) => {
        listener();
      });
    },
    setPlaybackAllowed: (allowedValue) => {
      playbackAllowed = allowedValue;
    },
    startAudio,
    off,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

test('starts every blocked room from one click and hides after playback recovers', async () => {
  const first = fakeRoom(false);
  const second = fakeRoom(false);
  const telemetry = {
    event: vi.fn(),
    failure: vi.fn(),
    step: vi.fn(<T>(_stage: string, action: () => Promise<T>): Promise<T> => action()),
  } as unknown as TelemetryStub;
  const rooms: CallTransportRoom[] = [
    { backendId: 'first', room: first.room },
    { backendId: 'second', room: second.room },
  ];
  const instance = mount(CallPlayback, {
    target: document.body,
    props: { rooms, telemetry },
  });
  await tick();

  const button = document.querySelector('button');
  expect(button?.textContent).toContain('Enable audio');
  button?.click();
  expect(first.startAudio).toHaveBeenCalledOnce();
  expect(second.startAudio).toHaveBeenCalledOnce();

  first.emit();
  second.emit();
  await tick();
  expect(document.querySelector('button')).toBeNull();
  expect(telemetry.step).toHaveBeenCalledWith('call.audio.playback_enable', expect.any(Function));

  await unmount(instance);
  expect(first.off).toHaveBeenCalledWith(
    RoomEvent.AudioPlaybackStatusChanged,
    expect.any(Function)
  );
});

test('reports playback failure and keeps the button visible', async () => {
  const room = fakeRoom(false);
  const error = new Error('blocked');
  room.startAudio.mockRejectedValueOnce(error);
  const telemetry = {
    event: vi.fn(),
    failure: vi.fn(),
    step: vi.fn(<T>(_stage: string, action: () => Promise<T>): Promise<T> => action()),
  } as unknown as TelemetryStub;
  const instance = mount(CallPlayback, {
    target: document.body,
    props: { rooms: [{ backendId: 'first', room: room.room }], telemetry },
  });
  await tick();
  document.querySelector('button')?.click();
  await tick();

  expect(telemetry.failure).toHaveBeenCalledWith('call.audio.playback_enable', error);
  expect(document.querySelector('button')).not.toBeNull();
  await unmount(instance);
});
