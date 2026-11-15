import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ScreenAudioListing } from '../../src/lib/platform/screen-audio-types';
import * as windowsScreenAudio from './windows-screen-audio';
import * as audiofox from './audiofox';

export const SCREEN_AUDIO_LABEL = 'vencord-screen-share';

type Selection =
  | { kind: 'system'; exclude: string[]; workaround: boolean }
  | { kind: 'apps'; include: string[]; workaround: boolean };

type Node = Partial<Record<string, string>>;

interface PatchBay {
  link(data: { include?: Node[]; exclude?: Node[]; mute?: boolean; workaround?: Node[] }): boolean;
  unmute(): void;
  unlink(): void;
}

interface Venmic {
  PatchBay: new () => PatchBay;
}

let patchBay: PatchBay | null | undefined;
let linked = false;

function venmic(): PatchBay | null {
  if (patchBay !== undefined) return patchBay;
  patchBay = null;
  try {
    const load = createRequire(join(__dirname, 'main.cjs'));
    const { PatchBay } = load(join(__dirname, `venmic-${process.arch}.node`)) as Venmic;
    patchBay = new PatchBay();
  } catch (error) {
    console.error('[sable screen audio] venmic did not load', error);
  }
  return patchBay;
}

function ownAudio(): Node {
  const pid = app.getAppMetrics().find((process) => process.name === 'Audio Service')?.pid;
  return { 'application.process.id': String(pid ?? -1) };
}

const SOURCE_PREFIX = 'pipewire:';
const SOURCE_PROPS = [
  'application.name',
  'application.process.id',
  'node.name',
  'media.name',
  'object.serial',
];

export async function listApps(): Promise<ScreenAudioListing> {
  if (!audiofox.available) return { apps: [], status: 'unavailable' };
  try {
    return await audiofox.listApps();
  } catch (error) {
    console.error('[sable screen audio] Audiofox did not load', error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      apps: [],
      status: /glibc|glibcxx|cxxabi/i.test(message) ? 'incompatible' : 'unavailable',
    };
  }
}

function nodesFor(names: string[]): Node[] {
  return names.map((name) => {
    const source = audiofox.sourceName(name);
    if (source) return { 'node.name': source };
    if (!name.startsWith(SOURCE_PREFIX)) return { 'application.name': name };
    const value: unknown = JSON.parse(name.slice(SOURCE_PREFIX.length));
    if (typeof value !== 'object' || value === null) throw new Error('invalid audio source');
    const props = Object.fromEntries(
      SOURCE_PROPS.flatMap((key) => {
        const entry = (value as Record<string, unknown>)[key];
        return typeof entry === 'string' && entry ? [[key, entry]] : [];
      })
    );
    if (Object.keys(props).length === 0) throw new Error('invalid audio source');
    return props;
  });
}

function parse(value: unknown): Selection | null {
  if (typeof value !== 'object' || value === null) return null;
  const selection = value as Record<string, unknown>;
  const names = (list: unknown) =>
    Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [];
  const workaround = selection.workaround === true;
  if (selection.kind === 'system')
    return { kind: 'system', exclude: names(selection.exclude), workaround };
  if (selection.kind === 'apps')
    return { kind: 'apps', include: names(selection.include), workaround };
  return null;
}

export function start(value: unknown): string {
  const selection = parse(value);
  const bay = venmic();
  if (selection?.kind !== 'system' || !bay) throw new Error('screen audio is unavailable');

  const workaround = selection.workaround ? [{ ...ownAudio(), 'media.name': 'RecordStream' }] : [];
  linked = bay.link({
    include: [{ 'media.class': 'Stream/Output/Audio' }],
    exclude: [ownAudio(), ...nodesFor(selection.exclude)],
    mute: true,
    workaround,
  });
  if (!linked) {
    bay.unlink();
    throw new Error('screen audio could not be linked');
  }
  return SCREEN_AUDIO_LABEL;
}

export function stop(): void {
  audiofox.stop();
  if (process.platform === 'win32') {
    windowsScreenAudio.stop();
    return;
  }
  linked = false;
  patchBay?.unlink();
}

export function unmute(): void {
  if (linked) patchBay?.unmute();
}

export async function startStream(value: unknown, frames: (data: Buffer) => void): Promise<void> {
  const selection = parse(value);
  if (process.platform === 'win32' && selection?.kind === 'system') {
    stop();
    windowsScreenAudio.start(value, frames);
    return;
  }
  if (!audiofox.available || selection?.kind !== 'apps')
    throw new Error('Application audio sharing is unavailable');
  stop();
  await audiofox.start(selection.include, frames);
}
