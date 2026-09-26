// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';
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
  const user = userEvent.setup();
  const instance = render(CallPlayback, { rooms, telemetry });

  await user.click(screen.getByRole('button', { name: /Enable audio/ }));
  expect(first.startAudio).toHaveBeenCalledOnce();
  expect(second.startAudio).toHaveBeenCalledOnce();

  first.emit();
  second.emit();
  await tick();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(telemetry.step).toHaveBeenCalledWith('call.audio.playback_enable', expect.any(Function));

  instance.unmount();
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
  const user = userEvent.setup();
  render(CallPlayback, { rooms: [{ backendId: 'first', room: room.room }], telemetry });
  await user.click(screen.getByRole('button', { name: /Enable audio/ }));

  expect(telemetry.failure).toHaveBeenCalledWith('call.audio.playback_enable', error);
  expect(screen.getByRole('button', { name: /Enable audio/ })).toBeInTheDocument();
});
