import { addPluginListener, invoke } from '@tauri-apps/api/core';

import { writeCacheFile } from './files.js';
import { isNativeMobile } from './os.js';

const FOLDER = 'native-audio';

interface PluginState {
  status: 'idle' | 'loading' | 'playing' | 'ended' | 'error';
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  error?: string;
}

export interface NativeTrack {
  /** The blob URL the timeline already holds; it also tells tracks apart. */
  url: string;
  name: string;
}

export interface NativeTrackState {
  playing: boolean;
  ended: boolean;
  currentTime: number;
  duration: number | null;
}

let activeUrl = $state<string | null>(null);
let plugin = $state<PluginState | null>(null);
let ready: Promise<void> | null = null;
let activePath: string | null = null;
let loads = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * The webviews mute or freeze `<audio>` once the app leaves the screen, so the phone apps play
 * through the system player, which also brings lock screen and notification controls.
 */
export function playsNatively(): boolean {
  return isNativeMobile();
}

function setUp(): Promise<void> {
  ready ??= (async () => {
    await addPluginListener<PluginState>('native-audio', 'native_audio_state', (next) => {
      plugin = next;
    });
    plugin = await invoke<PluginState>('plugin:native-audio|initialize');
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function load(track: NativeTrack): Promise<void> {
  await setUp();
  if (activeUrl === track.url) return;
  const bytes = new Uint8Array(await (await fetch(track.url)).arrayBuffer());
  loads += 1;
  const path = await writeCacheFile(FOLDER, `${String(loads)}-${track.name}`, bytes);
  plugin = await invoke<PluginState>('plugin:native-audio|set_source', {
    src: path,
    title: track.name,
  });
  const previous = activePath;
  activeUrl = track.url;
  activePath = path;
  if (previous !== null) {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(previous).catch((error: unknown) => {
      console.debug('[sable audio] the previous track was not removed', previous, error);
    });
  }
}

export const nativeAudio = {
  /** Null while another track, or none, holds the player. */
  of(url: string): NativeTrackState | null {
    if (activeUrl !== url || plugin === null) return null;
    return {
      playing: plugin.isPlaying,
      ended: plugin.status === 'ended',
      currentTime: plugin.currentTime,
      duration: plugin.duration > 0 ? plugin.duration : null,
    };
  },
  toggle(track: NativeTrack, rate = 1): Promise<void> {
    return serial(async () => {
      if (activeUrl === track.url && plugin?.isPlaying) {
        plugin = await invoke<PluginState>('plugin:native-audio|pause');
        return;
      }
      await load(track);
      await invoke('plugin:native-audio|set_rate', { rate });
      plugin = await invoke<PluginState>('plugin:native-audio|play');
    });
  },
  seek(track: NativeTrack, position: number): Promise<void> {
    return serial(async () => {
      await load(track);
      plugin = await invoke<PluginState>('plugin:native-audio|seek_to', { position });
    });
  },
  setRate(url: string, rate: number): Promise<void> {
    return serial(async () => {
      if (activeUrl !== url) return;
      plugin = await invoke<PluginState>('plugin:native-audio|set_rate', { rate });
    });
  },
};
