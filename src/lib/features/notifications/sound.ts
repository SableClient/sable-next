import { recordDebugLog } from '#lib/observability/debug-log.svelte.js';
import { nativeCallOwnsAudio } from '#lib/platform/calls.js';
import { isAndroid } from '#lib/platform/os.js';
import { playNativeChime } from '#lib/platform/native-notifications.js';
import { preferences, type RangePreference } from '#lib/settings/preferences.svelte.js';

export type NotificationSounds = {
  notification: { path: string; volumePreference: RangePreference };
  camera_off: { path: string; volumePreference: RangePreference };
  camera_on: { path: string; volumePreference: RangePreference };
  deafen_off: { path: string; volumePreference: RangePreference };
  deafen_on: { path: string; volumePreference: RangePreference };
  mic_off: { path: string; volumePreference: RangePreference };
  mic_on: { path: string; volumePreference: RangePreference };
  screenshare_start: { path: string; volumePreference: RangePreference };
  screenshare_stop: { path: string; volumePreference: RangePreference };
  incoming_call: { path: string; volumePreference: RangePreference };
  outgoing_call: { path: string; volumePreference: RangePreference };
  call_join: { path: string; volumePreference: RangePreference };
  call_leave: { path: string; volumePreference: RangePreference };
};

const SOUNDS: NotificationSounds = {
  notification: { path: '/sound/msg.webm', volumePreference: 'soundsNotificationVolume' },
  camera_off: { path: '/sound/camera_off.webm', volumePreference: 'soundsCameraOffVolume' },
  camera_on: { path: '/sound/camera_on.webm', volumePreference: 'soundsCameraOnVolume' },
  deafen_off: { path: '/sound/deafen_off.webm', volumePreference: 'soundsDeafenOffVolume' },
  deafen_on: { path: '/sound/deafen_on.webm', volumePreference: 'soundsDeafenOnVolume' },
  mic_off: { path: '/sound/mic_off.webm', volumePreference: 'soundsMicOffVolume' },
  mic_on: { path: '/sound/mic_on.webm', volumePreference: 'soundsMicOnVolume' },
  screenshare_start: {
    path: '/sound/screenshare_start.webm',
    volumePreference: 'soundsScreenshareStartVolume',
  },
  screenshare_stop: {
    path: '/sound/screenshare_stop.webm',
    volumePreference: 'soundsScreenshareStopVolume',
  },
  incoming_call: {
    path: '/sound/incoming_call.webm',
    volumePreference: 'soundsIncomingCallVolume',
  },
  outgoing_call: {
    path: '/sound/outgoing_call.webm',
    volumePreference: 'soundsOutgoingCallVolume',
  },
  call_join: { path: '/sound/call_join.webm', volumePreference: 'soundsCallJoinVolume' },
  call_leave: { path: '/sound/call_leave.webm', volumePreference: 'soundsCallLeaveVolume' },
};

/* All of the sounds are mixed at -6dB, we may want to tweak this */
const GAIN_MODIFIER = 1.0;

const RESUME_STALL_MS = 3000;

let context: AudioContext | undefined;
let playing: AudioBufferSourceNode | undefined;
const sounds = new Map<keyof NotificationSounds, Promise<AudioBuffer>>();

export type NotificationSound = { stop: () => void };

function load(name: keyof NotificationSounds, audioContext: AudioContext): Promise<AudioBuffer> {
  let sound = sounds.get(name);
  if (!sound) {
    sound = fetch(SOUNDS[name].path)
      .then((response) => response.arrayBuffer())
      .then((bytes) => audioContext.decodeAudioData(bytes));
    sounds.set(name, sound);
    sound.catch(() => sounds.delete(name));
  }
  return sound;
}

async function start(
  name: keyof NotificationSounds,
  options: { exclusive: boolean; loop?: boolean }
): Promise<AudioBufferSourceNode | null> {
  if (nativeCallOwnsAudio()) {
    recordDebugLog('debug', 'notification', 'sound', 'skipped', { native_call: true });
    return null;
  }
  const audioContext = (context ??= new AudioContext());
  try {
    const buffer = await load(name, audioContext);
    if (options.exclusive && (context !== audioContext || playing !== undefined)) {
      recordDebugLog('debug', 'notification', 'sound', 'skipped', {
        replaced: context !== audioContext,
        playing: playing !== undefined,
      });
      return null;
    }
    if (audioContext.state !== 'running') {
      recordDebugLog('debug', 'notification', 'sound', 'resuming', { state: audioContext.state });
      const stalled = setTimeout(() => {
        console.warn('[sable notification sound] resume stalled', audioContext.state);
      }, RESUME_STALL_MS);
      try {
        await audioContext.resume();
      } finally {
        clearTimeout(stalled);
      }
    }
    if (context !== audioContext) {
      if (options.exclusive) return null;
      throw new Error('AudioContext was changed mid-playback');
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    const gain = audioContext.createGain();
    gain.gain.value = preferences[SOUNDS[name].volumePreference] * GAIN_MODIFIER;
    source.connect(gain).connect(audioContext.destination);
    playing = source;
    source.addEventListener('ended', () => {
      if (playing === source) playing = undefined;
    });
    source.start();
    recordDebugLog('debug', 'notification', 'sound', 'started', {
      state: audioContext.state,
      volume: gain.gain.value,
    });
    return source;
  } catch (error) {
    if (context === audioContext) {
      context = undefined;
      playing = undefined;
    }
    if (audioContext.state !== 'closed') void audioContext.close();
    throw error;
  }
}

/** Closes the shared context, which otherwise keeps the WebView holding the audio session. */
export function releaseNotificationAudio(): void {
  const current = context;
  context = undefined;
  playing = undefined;
  if (current && current.state !== 'closed') void current.close().catch(() => {});
}

/** On the web, skipped while another sound is playing. */
export async function playNotificationSound(name: keyof NotificationSounds): Promise<void> {
  if (name === 'notification' && isAndroid()) {
    await playNativeChime(preferences[SOUNDS[name].volumePreference] * GAIN_MODIFIER);
    return;
  }
  await start(name, { exclusive: true });
}

export async function playSound(
  name: keyof NotificationSounds,
  options: { blocking?: boolean; loop?: boolean } = {}
): Promise<NotificationSound> {
  const source = await start(name, { exclusive: false, loop: options.loop });
  if (!source) return { stop: () => {} };
  if (options.blocking) await new Promise((resolve) => (source.onended = resolve));
  return {
    stop: () => {
      source.stop();
    },
  };
}
