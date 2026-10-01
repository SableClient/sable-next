// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RoomEvent, Track, type RemoteTrack, type Room } from 'livekit-client';
import { tick } from 'svelte';

import CallAudio from './CallAudio.svelte';
import CallAudioHarness from './CallAudioHarness.test.svelte';
import CallAudioUpdatesHarness from './CallAudioUpdatesHarness.test.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';
import * as voiceFilter from './voice-filter';
import {
  effectiveVolume,
  screenVolumeKey,
  setOutputVolume,
  setParticipantVolume,
} from './participant-volumes.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

test('updates voice and screen volume for late subscriptions', async () => {
  const room = fakeRoom();
  const identity = 'late-participant';
  const screenKey = screenVolumeKey(identity);
  setOutputVolume(1);
  setParticipantVolume(identity, 1);
  setParticipantVolume(screenKey, 0.6);
  const volumeOf = (identity: string, screen: boolean) =>
    effectiveVolume(screen ? screenVolumeKey(identity) : identity);
  const playback = $state({ deafened: false });
  const instance = render(CallAudio, {
    room: room.room,
    volumeOf,
    get deafened() {
      return playback.deafened;
    },
  });

  try {
    const voice = fakeTrack('late');
    const sharedAudio = Object.assign(fakeTrack('late-screen'), {
      source: Track.Source.ScreenShareAudio,
    });
    room.emit(RoomEvent.TrackSubscribed, voice, undefined, { identity });
    room.emit(RoomEvent.TrackSubscribed, sharedAudio, undefined, { identity });
    await tick();
    const [element, screenElement] = document.querySelectorAll('audio');
    expect(element.volume).toBe(1);
    expect(screenElement.volume).toBe(0.6);

    setParticipantVolume(identity, 0.4);
    await tick();
    expect(element.volume).toBe(0.4);
    expect(screenElement.volume).toBe(0.6);

    setOutputVolume(0.5);
    await tick();
    expect(element.volume).toBe(0.2);
    expect(screenElement.volume).toBe(0.3);

    setParticipantVolume(screenKey, 0);
    await tick();
    expect(element.volume).toBe(0.2);
    expect(screenElement.volume).toBe(0);

    playback.deafened = true;
    await tick();
    expect(element.muted).toBe(true);
    expect(screenElement.muted).toBe(true);
    playback.deafened = false;
    await tick();
    expect(element.muted).toBe(false);
    expect(element.volume).toBe(0.2);
    expect(screenElement.volume).toBe(0);
    expect(voice.attach).toHaveBeenCalledOnce();
    expect(voice.detach).not.toHaveBeenCalled();
    expect(sharedAudio.attach).toHaveBeenCalledOnce();
  } finally {
    instance.unmount();
    setOutputVolume(1);
    setParticipantVolume(identity, 1);
    setParticipantVolume(screenKey, 1);
  }
});

test('plays a shared screen at its own volume, apart from the voice', () => {
  const voice = fakeTrack('voice');
  const room = fakeRoom(voice);
  const screenAudio = Object.assign(fakeTrack('screen'), {
    source: Track.Source.ScreenShareAudio,
  });

  render(CallAudio, {
    room: room.room,
    volumeOf: (_identity: string, screen: boolean) => (screen ? 0.25 : 0.8),
  });
  room.emit(RoomEvent.TrackSubscribed, screenAudio, undefined, { identity: 'participant' });

  const [voiceElement, screenElement] = document.querySelectorAll('audio');
  expect(voiceElement.volume).toBe(0.8);
  expect(screenElement.volume).toBe(0.25);
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

test('keeps audio attached across participant updates', async () => {
  const track = fakeTrack('voice');
  const room = fakeRoom(track);
  const user = userEvent.setup();
  const instance = render(CallAudioUpdatesHarness, { room: room.room });

  for (let update = 0; update < 5; update += 1) {
    await user.click(screen.getByRole('button', { name: 'update participants' }));
  }

  expect(track.attach).toHaveBeenCalledOnce();
  expect(track.detach).not.toHaveBeenCalled();
  expect(room.listenerCount(RoomEvent.TrackSubscribed)).toBe(1);
  instance.unmount();
  expect(track.detach).toHaveBeenCalledOnce();
});

test('keeps incoming filters across participant updates', async () => {
  const source = { connect: vi.fn((node: AudioNode) => node), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const filter = { connect: vi.fn((node: AudioNode) => node), disconnect: vi.fn() };
  const bank = {
    context: {
      destination: {},
      createMediaStreamSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      resume: vi.fn(() => Promise.resolve()),
    },
    create: vi.fn(() => Promise.resolve(filter)),
    close: vi.fn(),
  };
  vi.spyOn(voiceFilter, 'supportsVoiceFilter').mockReturnValue(true);
  const createBank = vi
    .spyOn(voiceFilter, 'createVoiceFilterBank')
    .mockReturnValue(bank as unknown as voiceFilter.VoiceFilterBank);
  vi.stubGlobal('MediaStream', vi.fn());
  const previousIsolation = preferences.incomingVoiceIsolation;
  preferences.incomingVoiceIsolation = true;

  const track = fakeTrack('voice');
  const room = fakeRoom(track);
  const user = userEvent.setup();
  const instance = render(CallAudioUpdatesHarness, { room: room.room });

  try {
    for (let update = 0; update < 5; update += 1) {
      await user.click(screen.getByRole('button', { name: 'update participants' }));
    }

    expect(createBank).toHaveBeenCalledOnce();
    expect(bank.create).toHaveBeenCalledOnce();
    expect(bank.close).not.toHaveBeenCalled();
    expect(track.detach).not.toHaveBeenCalled();
    expect(document.querySelector('audio')?.muted).toBe(true);
    expect(source.connect).toHaveBeenLastCalledWith(filter);
  } finally {
    instance.unmount();
    preferences.incomingVoiceIsolation = previousIsolation;
  }

  expect(bank.close).toHaveBeenCalledOnce();
  expect(filter.disconnect).toHaveBeenCalledOnce();
});
