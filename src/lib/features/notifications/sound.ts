import { recordDebugLog } from '#lib/observability/debug-log.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const SOUND_URL = '/sound/notification.ogg';
const RESUME_STALL_MS = 3000;

let context: AudioContext | undefined;
let playing: AudioBufferSourceNode | undefined;
let sound: Promise<AudioBuffer> | undefined;

export async function playNotificationSound(): Promise<void> {
  const audioContext = (context ??= new AudioContext());
  sound ??= fetch(SOUND_URL)
    .then((response) => response.arrayBuffer())
    .then((bytes) => audioContext.decodeAudioData(bytes));

  try {
    const buffer = await sound;
    if (context !== audioContext || playing !== undefined) {
      recordDebugLog('debug', 'notification', 'sound', 'skipped', {
        replaced: context !== audioContext,
        playing: playing !== undefined,
      });
      return;
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
    if (context !== audioContext) return;

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    const gain = audioContext.createGain();
    gain.gain.value = preferences.notificationSoundVolume;
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
  } catch (error) {
    if (context === audioContext) {
      context = undefined;
      playing = undefined;
      sound = undefined;
    }
    if (audioContext.state !== 'closed') void audioContext.close();
    throw error;
  }
}
