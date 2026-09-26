// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { RoomEvent, Track, type RemoteTrack, type Room } from 'livekit-client';

import CallAudio from './CallAudio.svelte';
import CallAudioHarness from './CallAudioHarness.test.svelte';

type FakeRoom = {
  room: Room;
  emit: (event: RoomEvent, ...args: unknown[]) => void;
  listenerCount: (event: RoomEvent) => number;
  setPlaybackAllowed: (allowed: boolean) => void;
};

function fakeTrack(sid: string) {
  const element = document.createElement('audio');
  return {
    kind: Track.Kind.Audio,
    sid,
    attach: vi.fn(() => element),
    detach: vi.fn(),
  } as unknown as RemoteTrack & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
}

function fakeRoom(initialTrack?: RemoteTrack): FakeRoom {
  const listeners = new Map<RoomEvent, Set<(...args: unknown[]) => void>>();
  let playbackAllowed = true;
  const room = {
    remoteParticipants: new Map([
      [
        'participant',
        {
          identity: 'participant',
          audioTrackPublications: new Map([['publication', { track: initialTrack }]]),
        },
      ],
    ]),
    get canPlaybackAudio() {
      return playbackAllowed;
    },
    on(event: RoomEvent, listener: (...args: unknown[]) => void) {
      let eventListeners = listeners.get(event);
      if (!eventListeners) {
        eventListeners = new Set();
        listeners.set(event, eventListeners);
      }
      eventListeners.add(listener);
      return room;
    },
    off(event: RoomEvent, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return room;
    },
  } as unknown as Room;

  return {
    room,
    emit: (event, ...args) => {
      listeners.get(event)?.forEach((listener) => {
        listener(...args);
      });
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    setPlaybackAllowed: (allowed) => {
      playbackAllowed = allowed;
    },
  };
}

test('attaches existing and newly subscribed remote audio and reports playback status', () => {
  const initial = fakeTrack('initial');
  const next = fakeTrack('next');
  const room = fakeRoom(initial);
  const telemetry = { event: vi.fn(), failure: vi.fn() };

  const instance = render(CallAudio, { room: room.room, telemetry });

  expect(initial.attach).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('audio')).toHaveLength(1);
  expect(telemetry.event).toHaveBeenCalledWith('call.audio.playback_status', {
    'audio.playback_allowed': true,
  });

  room.emit(RoomEvent.TrackSubscribed, next, undefined, { identity: 'next' });
  expect(next.attach).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('audio')).toHaveLength(2);

  room.setPlaybackAllowed(false);
  room.emit(RoomEvent.AudioPlaybackStatusChanged);
  expect(telemetry.event).toHaveBeenCalledWith('call.audio.playback_status', {
    'audio.playback_allowed': false,
  });

  instance.unmount();
  expect(initial.detach).toHaveBeenCalledOnce();
  expect(next.detach).toHaveBeenCalledOnce();
  expect(room.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
  expect(room.listenerCount(RoomEvent.TrackUnsubscribed)).toBe(0);
  expect(room.listenerCount(RoomEvent.AudioPlaybackStatusChanged)).toBe(0);
});

test('applies a per-participant volume to attached audio', () => {
  const initial = fakeTrack('initial');
  const room = fakeRoom(initial);
  const volumes: Record<string, number> = { participant: 0.4, next: 0 };

  render(CallAudio, { room: room.room, volumeOf: (identity: string) => volumes[identity] ?? 1 });

  const elements = () => [...document.querySelectorAll('audio')];
  expect(elements()[0].volume).toBe(0.4);

  room.emit(RoomEvent.TrackSubscribed, fakeTrack('next'), undefined, { identity: 'next' });
  expect(elements()[1].volume).toBe(0);
});

test('replaces room listeners and tracks with the current room', async () => {
  const firstTrack = fakeTrack('first');
  const secondTrack = fakeTrack('second');
  const first = fakeRoom(firstTrack);
  const second = fakeRoom(secondTrack);

  render(CallAudioHarness, { first: first.room, second: second.room });

  expect(firstTrack.attach).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'replace' }));

  expect(firstTrack.detach).toHaveBeenCalledOnce();
  expect(secondTrack.attach).toHaveBeenCalledOnce();
  expect(first.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
  expect(second.listenerCount(RoomEvent.TrackSubscribed)).toBe(1);
});
